import { Schema } from "effect";
import { organizationAuditOperationForEvent } from "../audit/organization-audit-log.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { DynamoValue } from "../record-schema.ts";
import { OPERATOR_ACCESS_INDEX_PARTITION } from "../record-key-secondary.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  OrganizationOperatorAccessRecord,
  type OrganizationOperatorAccess,
} from "../records/operator-access.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  decodeSystemCursor,
  encodeSystemCursor,
  runSystemPersistence,
  systemPageLimit,
  type SystemPage,
  type SystemPageOptions,
} from "../system/support.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  OperatorAccessDurationError,
  closeOperatorAccess,
  openOperatorAccess,
  operatorAccessStatus,
  type OperatorAccessStatus,
} from "./lifecycle.ts";

const MAX_WRITE_ATTEMPTS = 5;
const AGGREGATE_TYPE = "organization-operator-access";

export const OPERATOR_ACCESS_EVENTS = {
  closed: "organization.operator-access-closed",
  opened: "organization.operator-access-opened",
  renewed: "organization.operator-access-renewed",
} as const;

export interface OperatorAccessView extends OrganizationOperatorAccess {
  readonly status: OperatorAccessStatus;
}

export type OperatorAccessOpenOutcome = {
  readonly access: OperatorAccessView;
  readonly kind: "opened" | "renewed";
};

export type OperatorAccessCloseOutcome =
  | { readonly access: OperatorAccessView; readonly changed: true }
  | { readonly access: OperatorAccessView | undefined; readonly changed: false };

/** What an operator may know about an organization without access to its data. */
export interface OperatorAccessOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "archived" | "disabled";
}

export interface OperatorAccessRepository {
  /** The organization and the caller's stored grant for it, open or not. */
  readonly get: (input: { readonly organizationId: Ulid; readonly principalId: Ulid }) => Promise<{
    readonly access: OperatorAccessView | undefined;
    readonly organization: OperatorAccessOrganization;
  }>;
  readonly open: (input: {
    readonly durationMinutes?: number;
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
    readonly reason: string;
    readonly ticket?: string;
  }) => Promise<OperatorAccessOpenOutcome>;
  readonly close: (input: {
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
  }) => Promise<OperatorAccessCloseOutcome>;
  /** Unexpired open grants, across the install or in one organization. */
  readonly listOpen: (
    input: SystemPageOptions & { readonly organizationId?: Ulid },
  ) => Promise<SystemPage<OperatorAccessView>>;
}

function view(access: OrganizationOperatorAccess, now: Date): OperatorAccessView {
  return { ...access, status: operatorAccessStatus(access, now) };
}

function openedPayload(access: OrganizationOperatorAccess): Record<string, DynamoValue> {
  return {
    expiresAt: access.expiresAt,
    grantId: access.grantId,
    principalId: access.principalId,
    reason: access.reason,
    ...(access.ticket === undefined ? {} : { ticket: access.ticket }),
  };
}

export function makeOperatorAccessRepository(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}): OperatorAccessRepository {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());

  async function load(organizationId: Ulid, principalId: Ulid) {
    const stored = await database.getRecord(
      "control",
      Keys.control.organizationOperatorAccess(organizationId, principalId),
      true,
    );
    return stored?.itemType === "organization-operator-access" ? stored : undefined;
  }

  async function loadOrganization(organizationId: Ulid): Promise<OperatorAccessOrganization> {
    const organization = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      true,
    );
    if (organization?.itemType !== "organization") {
      throw new PersistenceError(
        "not-found",
        "organization_not_found",
        `Organization ${organizationId} does not exist.`,
      );
    }
    const { id, name, slug, status } = organization.data;
    return { id, name, slug, status };
  }

  /** Support often happens on disabled organizations; archived ones have no tenant data to serve. */
  async function requireServiceableOrganization(organizationId: Ulid) {
    const organization = await loadOrganization(organizationId);
    if (organization.status === "archived") {
      throw new PersistenceError(
        "conflict",
        "organization_archived",
        `Organization ${organizationId} is archived, so operator access cannot be opened.`,
      );
    }
  }

  async function commit(
    previous: OrganizationOperatorAccessRecord | undefined,
    next: OrganizationOperatorAccess,
    eventType: string,
    payload: Record<string, DynamoValue>,
  ) {
    const record = Schema.decodeUnknownSync(OrganizationOperatorAccessRecord)(
      withCanonicalRecordKeys({ data: next, itemType: "organization-operator-access" as const }),
    );
    const event = makeSemanticEventRecord({
      actor: { id: next.principalId, type: "principal" },
      aggregateId: next.principalId,
      aggregateType: AGGREGATE_TYPE,
      aggregateVersion: next.version,
      eventId: generateId(),
      eventType,
      occurredAt: next.updatedAt,
      organizationId: next.organizationId,
      payload,
    });
    await transactWithSemanticEvents(
      database,
      [
        { kind: "put", ...(previous ? { previousRecord: previous } : {}), record },
        organizationAuditOperationForEvent(event, { id: next.principalId, type: "principal" }),
      ],
      [event],
    );
  }

  async function retrying<T>(attempt: () => Promise<T | undefined>): Promise<T> {
    for (let attempts = 1; ; attempts += 1) {
      try {
        const result = await attempt();
        if (result !== undefined) return result;
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
      if (attempts >= MAX_WRITE_ATTEMPTS) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The operator access record kept changing concurrently; retry the request.",
        );
      }
    }
  }

  return {
    close: ({ organizationId, principalId }) =>
      retrying(async () => {
        const previous = await load(organizationId, principalId);
        const at = now();
        const next = closeOperatorAccess(previous?.data, at);
        if (!previous || !next) {
          return { access: previous && view(previous.data, at), changed: false as const };
        }
        await commit(previous, next, OPERATOR_ACCESS_EVENTS.closed, {
          closedReason: "closed",
          grantId: next.grantId,
          principalId,
        });
        return { access: view(next, at), changed: true as const };
      }),
    get: async ({ organizationId, principalId }) => {
      const [organization, stored] = await Promise.all([
        loadOrganization(organizationId),
        runSystemPersistence("read operator access", load(organizationId, principalId)),
      ]);
      return { access: stored && view(stored.data, now()), organization };
    },
    listOpen: async (options) => {
      const at = now();
      const limit = systemPageLimit(options.limit);
      const page = options.organizationId
        ? await runSystemPersistence(
            "list operator access",
            database.queryRecords("control", {
              ConsistentRead: true,
              ...(options.cursor
                ? {
                    ExclusiveStartKey: decodeSystemCursor(options.cursor, {
                      partition: key("ORG", options.organizationId),
                      partitionField: "pk",
                    }),
                  }
                : {}),
              ExpressionAttributeValues: {
                ":pk": key("ORG", options.organizationId),
                ":sk": `${key("ORGANIZATION-OPERATOR-ACCESS")}#`,
              },
              KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
              Limit: limit,
            }),
          )
        : await runSystemPersistence(
            "list operator access",
            database.queryRecords("control", {
              ...(options.cursor
                ? {
                    ExclusiveStartKey: decodeSystemCursor(options.cursor, {
                      partition: OPERATOR_ACCESS_INDEX_PARTITION,
                      partitionField: "gsi2pk",
                    }),
                  }
                : {}),
              ExpressionAttributeValues: {
                ":lower": key("open", at.toISOString()),
                ":pk": OPERATOR_ACCESS_INDEX_PARTITION,
                ":upper": key("open", "~"),
              },
              IndexName: "gsi2",
              KeyConditionExpression: "gsi2pk = :pk AND gsi2sk BETWEEN :lower AND :upper",
              Limit: limit,
            }),
          );
      return {
        items: page.items.flatMap((record) =>
          record.itemType === "organization-operator-access" &&
          operatorAccessStatus(record.data, at) === "open"
            ? [view(record.data, at)]
            : [],
        ),
        ...(page.lastEvaluatedKey ? { nextCursor: encodeSystemCursor(page.lastEvaluatedKey) } : {}),
      };
    },
    open: async ({ durationMinutes, organizationId, principalId, reason, ticket }) => {
      await requireServiceableOrganization(organizationId);
      return retrying(async () => {
        const previous = await load(organizationId, principalId);
        const at = now();
        let transition: ReturnType<typeof openOperatorAccess>;
        try {
          transition = openOperatorAccess(
            previous?.data,
            {
              ...(durationMinutes === undefined ? {} : { durationMinutes }),
              grantId: generateId(),
              organizationId,
              principalId,
              reason,
              ...(ticket === undefined ? {} : { ticket }),
            },
            at,
          );
        } catch (cause) {
          if (cause instanceof OperatorAccessDurationError) {
            throw new PersistenceError("invalid-input", "invalid_duration", cause.message);
          }
          throw cause;
        }
        await commit(
          previous,
          transition.next,
          OPERATOR_ACCESS_EVENTS[transition.kind],
          openedPayload(transition.next),
        );
        return { access: view(transition.next, at), kind: transition.kind };
      });
    },
  };
}
