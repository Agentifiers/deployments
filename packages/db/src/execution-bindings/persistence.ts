import { createHash } from "node:crypto";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import {
  snapshotExecutionBindingHostedCodeTools,
  type ExecutionBindingHostedCodeTool,
  type HostedCodeBindingSnapshot,
} from "../hosted-code/binding-pins.ts";
import { MAX_PINNED_HOSTED_CODE_TOOLS } from "../hosted-code/tool-snapshots.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import type { SemanticEventRecord } from "../records/events.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  expiredIdempotencyReplacementCondition,
  isDatabaseWriteConflict,
} from "../transaction-conditions.ts";

export type ExecutionBindingRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "execution-binding" }
>;
type IdempotencyRecordValue = Extract<PlatformRecord, { readonly itemType: "idempotency" }>;
type SemanticEventRecordValue = typeof SemanticEventRecord.Type;

export interface ExecutionBindingLocator {
  readonly environmentId: string;
  readonly executionBindingId: string;
  readonly organizationId: string;
}

export interface ExecutionBindingIdempotencyScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Logical activity check; DynamoDB TTL only removes expired bindings asynchronously. */
export function executionBindingIsActive(binding: ExecutionBindingRecordValue, at: Date): boolean {
  return binding.data.status === "active" && Date.parse(binding.data.expiresAt) > at.getTime();
}

/** Scopes caller idempotency keys to the environment and creating principal. */
export function executionBindingIdempotencyKey(
  scope: ExecutionBindingIdempotencyScope,
  value: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "execution-binding-v1",
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        scope.principalId,
        value,
      ]),
    )
    .digest("hex");
  return `execution-binding:${digest}`;
}

/**
 * Condition that fences a transaction on the binding version still being active at `at`. Runs
 * and threads written for a binding must carry this check so expiry and submission cannot race.
 */
export function activeExecutionBindingCondition(
  binding: ExecutionBindingRecordValue,
  at: Date,
): TransactionOperation {
  return {
    conditionExpression:
      "#data.#version = :version AND #data.#status = :active AND #data.#expiresAt > :now",
    expressionAttributeNames: {
      "#data": "data",
      "#expiresAt": "expiresAt",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":now": at.toISOString(),
      ":version": binding.data.version,
    },
    key: { pk: binding.pk, sk: binding.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function makeExecutionBindingPersistence(database: DynamoDatabaseService) {
  return {
    async get(locator: ExecutionBindingLocator): Promise<ExecutionBindingRecordValue | undefined> {
      const value = await database.getRecord(
        "control",
        {
          pk: key("ORG", locator.organizationId, "ENV", locator.environmentId),
          sk: key("EXECUTION-BINDING", locator.executionBindingId),
        },
        true,
      );
      return value?.itemType === "execution-binding" &&
        value.data.organizationId === locator.organizationId &&
        value.data.environmentId === locator.environmentId
        ? value
        : undefined;
    },

    async getIdempotency(
      organizationId: string,
      idempotencyKey: string,
    ): Promise<IdempotencyRecordValue | undefined> {
      const value = await database.getRecord(
        "events",
        { pk: key("ORG", organizationId), sk: key("IDEMPOTENCY", idempotencyKey) },
        true,
      );
      return value?.itemType === "idempotency" ? value : undefined;
    },

    /**
     * Resolves the hosted code pins a manifest-sourced binding must be created with. Semantic
     * issues must reject the binding; release-sourced bindings never get pins.
     */
    snapshotHostedCodeTools(
      binding: ExecutionBindingRecordValue,
    ): Promise<HostedCodeBindingSnapshot> {
      return snapshotExecutionBindingHostedCodeTools(database, binding);
    },

    /**
     * Creates the binding, its hosted code pins, and its idempotency claim atomically. An expired
     * idempotency claim is replaced; a live claim makes the transaction fail. Returns false on a
     * conditional conflict so callers can reconcile with the winning request.
     */
    async create(input: {
      readonly binding: ExecutionBindingRecordValue;
      readonly event: SemanticEventRecordValue;
      readonly hostedCodeTools: readonly ExecutionBindingHostedCodeTool[];
      readonly idempotency: IdempotencyRecordValue;
      readonly transactionToken: string;
    }): Promise<boolean> {
      const { binding, hostedCodeTools } = input;
      if (
        hostedCodeTools.length > MAX_PINNED_HOSTED_CODE_TOOLS ||
        (hostedCodeTools.length > 0 && binding.data.source.type !== "manifest") ||
        hostedCodeTools.some(
          (pin) =>
            pin.data.executionBindingId !== binding.data.id ||
            pin.data.organizationId !== binding.data.organizationId ||
            pin.data.projectId !== binding.data.projectId ||
            pin.data.environmentId !== binding.data.environmentId ||
            pin.data.expiresAt !== binding.data.expiresAt,
        )
      ) {
        throw new TypeError("Execution binding hosted code pins do not belong to the binding.");
      }
      try {
        await transactWithSemanticEvents(
          database,
          [
            { kind: "put", record: binding },
            ...hostedCodeTools.map((record) => ({ kind: "put" as const, record })),
            {
              ...expiredIdempotencyReplacementCondition(input.idempotency),
              kind: "put",
              record: input.idempotency,
              replaceExpired: true,
            },
          ],
          [input.event],
          input.transactionToken,
        );
        return true;
      } catch (cause) {
        if (isDatabaseWriteConflict(cause)) return false;
        throw cause;
      }
    },

    /** Persists an expiry transition; returns false when another writer changed the binding. */
    async expire(input: {
      readonly event: SemanticEventRecordValue;
      readonly expired: ExecutionBindingRecordValue;
      readonly previous: ExecutionBindingRecordValue;
      readonly transactionToken: string;
    }): Promise<boolean> {
      try {
        await transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: input.previous, record: input.expired }],
          [input.event],
          input.transactionToken,
        );
        return true;
      } catch (cause) {
        if (isDatabaseWriteConflict(cause)) return false;
        throw cause;
      }
    },

    /**
     * Commits a preview/evaluation turn (thread, message, run, and their lookups) fenced on the
     * binding remaining active. Returns false on a conditional conflict.
     */
    async commitBoundTurn(input: {
      readonly at: Date;
      readonly binding: ExecutionBindingRecordValue;
      readonly events: readonly SemanticEventRecordValue[];
      readonly operations: readonly TransactionOperation[];
      readonly transactionToken?: string;
    }): Promise<boolean> {
      try {
        await transactWithSemanticEvents(
          database,
          [...input.operations, activeExecutionBindingCondition(input.binding, input.at)],
          input.events,
          input.transactionToken,
        );
        return true;
      } catch (cause) {
        if (isDatabaseWriteConflict(cause)) return false;
        throw cause;
      }
    },
  };
}
