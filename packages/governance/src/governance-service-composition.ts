import { sha256 } from "./canonical.ts";
import { makeGovernanceAuditExport } from "./governance-audit-export.ts";
import { makeGovernanceOperationRunner } from "./governance-operation-runner.ts";
import { makeGovernanceRetentionRunner } from "./governance-retention-runner.ts";
import { makeGovernanceTenantExport } from "./governance-tenant-export.ts";
import { RETENTION_RESTAMP_START_DELAY_MILLISECONDS } from "@deployments-ai/db";
import {
  DEFAULT_RETENTION_POLICY,
  GovernanceError,
  type GovernanceObjectReference,
  type GovernanceOperation,
  type GovernanceOperationKind,
  type GovernanceServiceOptions,
  type RetentionPolicy,
  type RetentionPolicyPatch,
  type StoredRetentionPolicy,
} from "./types.ts";

import {
  DAY_MILLISECONDS,
  completedErasureOperation,
  validatePolicy,
} from "./governance-service-support.ts";
export function operation(
  input: {
    id: string;
    idempotencyKey: string;
    kind: GovernanceOperationKind;
    organizationId: string;
    requestedByPrincipalId: string;
  },
  now: string,
): GovernanceOperation {
  return {
    ...input,
    createdAt: now,
    status: "pending",
    updatedAt: now,
    version: 1,
  };
}

export function immutableRetainUntil(now: Date, auditRetentionDays: number) {
  return new Date(now.getTime() + auditRetentionDays * DAY_MILLISECONDS).toISOString();
}
export interface GovernanceServiceContext {
  readonly getOperation: (
    organizationId: string,
    operationId: string,
  ) => Promise<GovernanceOperation | undefined>;
  readonly getRetentionPolicy: (organizationId: string) => Promise<StoredRetentionPolicy>;
  readonly now: () => Date;
  readonly options: GovernanceServiceOptions;
  readonly writeObject: (
    organizationId: string,
    operationId: string,
    name: string,
    body: Uint8Array,
    contentType: "application/json" | "application/x-ndjson",
    immutable: boolean,
    retainUntil?: string,
  ) => Promise<GovernanceObjectReference>;
}

export function createGovernanceService(options: GovernanceServiceOptions) {
  const now = options.now ?? (() => new Date());

  const updateRetentionPolicy = async (input: {
    operatorAccessGrantId?: string;
    organizationId: string;
    patch: RetentionPolicyPatch;
    principalId: string;
  }): Promise<StoredRetentionPolicy> => {
    const previous = await options.store.getRetentionPolicy(input.organizationId);
    const patch = Object.fromEntries(
      Object.entries(input.patch).filter((entry): entry is [string, number] => {
        return entry[1] !== undefined;
      }),
    ) as Partial<RetentionPolicy>;
    const values: RetentionPolicy = {
      artifacts: previous?.artifacts ?? DEFAULT_RETENTION_POLICY.artifacts,
      audit: previous?.audit ?? DEFAULT_RETENTION_POLICY.audit,
      events: previous?.events ?? DEFAULT_RETENTION_POLICY.events,
      messages: previous?.messages ?? DEFAULT_RETENTION_POLICY.messages,
      runs: previous?.runs ?? DEFAULT_RETENTION_POLICY.runs,
      threads: previous?.threads ?? DEFAULT_RETENTION_POLICY.threads,
      ...patch,
    };
    validatePolicy(values);
    const timestamp = now().toISOString();
    const policy = {
      ...values,
      createdAt: previous?.createdAt ?? timestamp,
      organizationId: input.organizationId,
      updatedAt: timestamp,
      updatedByPrincipalId: input.principalId,
      version: (previous?.version ?? 0) + 1,
    };
    const before = previous ?? DEFAULT_RETENTION_POLICY;
    const restamp =
      policy.runs > before.runs || policy.events > before.events
        ? {
            createdAt: timestamp,
            dueAt: new Date(
              Date.parse(timestamp) + RETENTION_RESTAMP_START_DELAY_MILLISECONDS,
            ).toISOString(),
            organizationId: input.organizationId,
            phase: "soonest" as const,
            policyVersion: policy.version,
            updatedAt: timestamp,
            version: 1,
          }
        : undefined;
    try {
      await options.store.putRetentionPolicy(
        policy,
        previous?.version,
        restamp,
        input.operatorAccessGrantId,
      );
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "name" in cause &&
        (cause.name === "ConditionalCheckFailedException" ||
          cause.name === "TransactionCanceledException")
      ) {
        throw new GovernanceError(
          "retention_policy_conflict",
          "The retention policy changed while this update was being applied.",
        );
      }
      throw cause;
    }
    return policy;
  };

  const getRetentionPolicy = async (organizationId: string): Promise<StoredRetentionPolicy> => {
    const stored = await options.store.getRetentionPolicy(organizationId);
    if (stored) return stored;
    const timestamp = now().toISOString();
    return {
      ...DEFAULT_RETENTION_POLICY,
      createdAt: timestamp,
      organizationId,
      updatedAt: timestamp,
      updatedByPrincipalId: organizationId,
      version: 0,
    };
  };

  const getOperation = async (organizationId: string, operationId: string) => {
    const stored = await options.store.getOperation(organizationId, operationId);
    if (stored) return stored;
    const receipt = await options.store.getErasureReceipt(operationId);
    if (!receipt || receipt.organizationHash !== sha256(organizationId)) return undefined;
    return completedErasureOperation(organizationId, receipt);
  };

  const prepareOperation = async (input: {
    idempotencyKey: string;
    kind: GovernanceOperationKind;
    operationId?: string;
    organizationId: string;
    principalId: string;
  }) =>
    operation(
      {
        id: input.operationId ?? (await options.generateId()),
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        organizationId: input.organizationId,
        requestedByPrincipalId: input.principalId,
      },
      now().toISOString(),
    );

  const requestOperation = async (input: {
    idempotencyKey: string;
    kind: GovernanceOperationKind;
    operationId?: string;
    operatorAccessGrantId?: string;
    organizationId: string;
    principalId: string;
  }) => {
    const operationId = input.operationId ?? (await options.generateId());
    if (input.kind === "tenant-erasure") {
      const receipt = await options.store.getErasureReceipt(operationId);
      if (receipt?.organizationHash === sha256(input.organizationId)) {
        return completedErasureOperation(input.organizationId, receipt);
      }
      const existing = await options.store.getOperation(input.organizationId, operationId);
      if (existing?.kind === "tenant-erasure") {
        if (existing.requestedByPrincipalId === input.principalId) return existing;
        throw new GovernanceError(
          "tenant_erasure_already_requested",
          "Tenant erasure has already been requested by another principal.",
        );
      }
    }
    return options.store.createOperation(
      await prepareOperation({ ...input, operationId }),
      input.operatorAccessGrantId,
    );
  };

  const writeObject = async (
    organizationId: string,
    operationId: string,
    name: string,
    body: Uint8Array,
    contentType: "application/json" | "application/x-ndjson",
    immutable: boolean,
    retainUntil?: string,
  ): Promise<GovernanceObjectReference> => {
    const digest = sha256(body);
    return options.objectStore.put({
      body,
      contentType,
      immutable,
      key: `governance/${organizationId}/${operationId}/${name}`,
      ...(retainUntil ? { retainUntil } : {}),
      sha256: digest,
    });
  };
  const context: GovernanceServiceContext = {
    getOperation,
    getRetentionPolicy,
    now,
    options,
    writeObject,
  };
  const auditExport = makeGovernanceAuditExport(context);
  const tenantExport = makeGovernanceTenantExport(context);
  const runOperation = makeGovernanceOperationRunner({ ...context, auditExport, tenantExport });
  const runRetention = makeGovernanceRetentionRunner(context);
  return {
    getOperation,
    getRetentionPolicy,
    listOperations: options.store.listOperations,
    organizationExists: options.store.organizationExists,
    prepareOperation,
    requestOperation,
    runOperation,
    runRetention,
    updateRetentionPolicy,
  };
}

export type GovernanceService = ReturnType<typeof createGovernanceService>;
