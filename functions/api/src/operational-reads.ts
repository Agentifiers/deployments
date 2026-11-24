import {
  key,
  listOrganizationAuditEventPage,
  organizationAuditPartition,
  type DynamoDatabaseService,
  type OpaqueCursorCodec,
  type PlatformRecord,
  apiPersistence,
} from "@deployments-ai/db";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  OPERATIONAL_RECORD_PAGE_LIMIT,
  OPERATIONS_API_SCHEMAS,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import type { ApiIdentity } from "./index.ts";
import { canonicalTimestamp, OperationalReadError, pageLimit } from "./operational-read-input.ts";
import { readUsageSummary, summaryAttribution, summaryWindow } from "./usage-summary-reads.ts";
import { readWorkspaceSpend } from "./workspace-spend-reads.ts";
import {
  costListMetrics,
  isCostUsageMetric,
  openMetricCursor,
  readMetricIndexPage,
  sealMetricCursor,
  usageListMetrics,
  type MetricIndexPosition,
} from "./usage-metric-index.ts";

const MAX_CURSOR_LENGTH = 4_096;
const MAX_KEY_BYTES = { pk: 2_048, sk: 1_024 } as const;
const MAX_PHYSICAL_PAGES = 10;
const CURSOR_AAD = Buffer.from("deployments-ai:operational-read-cursor:v1", "utf8");

type UsageRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "inbox-usage"
      | "meter-event"
      | "storage-usage"
      | "usage-aggregate"
      | "usage-counter-shard";
  }
>;
type CostRecord = Extract<
  PlatformRecord,
  { readonly itemType: "cost-aggregate" | "usage-aggregate" | "usage-counter-shard" }
>;
type SpendRecord = Extract<
  PlatformRecord,
  { readonly itemType: "provider-billing-period" | "spend-ledger" }
>;
type ApiCredentialUsage = Extract<PlatformRecord, { readonly itemType: "api-credential-usage" }>;
type AuditEvent = Extract<PlatformRecord, { readonly itemType: "audit-event" }>;
type Environment = Extract<PlatformRecord, { readonly itemType: "environment" }>;

export interface OperationalReadInvocation {
  readonly id?: string;
  readonly identity: ApiIdentity;
  readonly query: Readonly<Record<string, string | number | undefined>>;
  readonly scope: { readonly environmentId?: string; readonly organizationId?: string };
}

type UsageSummary = typeof OPERATIONS_API_SCHEMAS.UsageSummaryResponse.Type;

export interface OperationalReadService {
  listUsage(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.OperationalRecordPageResponse.Type>;
  getUsageSummary(invocation: OperationalReadInvocation): Promise<UsageSummary>;
  listCosts(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.OperationalRecordPageResponse.Type>;
  getCostSummary(invocation: OperationalReadInvocation): Promise<UsageSummary>;
  getWorkspaceSpend(invocation: OperationalReadInvocation): ReturnType<typeof readWorkspaceSpend>;
  listSpend(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.OperationalRecordPageResponse.Type>;
  listApiCredentialUsage(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.OperationalRecordPageResponse.Type>;
  listAuditEvents(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.AuditEventPageResponse.Type>;
  getAuditEvent(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.AuditEventResponse.Type>;
  listOrganizationAuditEvents(
    invocation: OperationalReadInvocation,
  ): Promise<typeof OPERATIONS_API_SCHEMAS.OrganizationAuditEventPageResponse.Type>;
}

export interface OperationalReadServiceOptions {
  readonly cursorCodec: OpaqueCursorCodec;
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
}

export function makeAesGcmOperationalCursorCodec(
  keyValue: Uint8Array = randomBytes(32),
): OpaqueCursorCodec {
  const key = Buffer.from(keyValue);
  if (key.byteLength !== 32) throw new TypeError("Operational cursor keys must contain 32 bytes.");
  return {
    async open(ciphertext) {
      const bytes = Buffer.from(ciphertext, "base64url");
      if (bytes.byteLength < 29) throw new Error("Invalid encrypted cursor.");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(CURSOR_AAD);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
    async seal(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(CURSOR_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
    },
  };
}

function exactGrant(grants: readonly string[] | "*" | undefined, value: string) {
  return grants === "*" || grants?.includes(value) === true;
}

function requiredEnvironmentId(invocation: OperationalReadInvocation) {
  const environmentId = invocation.scope.environmentId;
  if (!environmentId) {
    throw new OperationalReadError(
      400,
      "missing_scope",
      "The environment scope header is required.",
    );
  }
  if (!exactGrant(invocation.identity.environmentIds, environmentId)) {
    throw new OperationalReadError(
      403,
      "environment_scope_violation",
      "The credential cannot access the requested environment.",
    );
  }
  return environmentId;
}

/**
 * Organization audit reads follow the governance contract: the scope header must name the path
 * organization, the credential needs an organization grant (a platform administrator holds one
 * only under open operator access), and an erased organization answers `410 organization_erased`.
 */
async function requiredOrganizationId(
  database: DynamoDatabaseService,
  invocation: OperationalReadInvocation,
) {
  const organizationId = invocation.id;
  if (!organizationId || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(organizationId)) {
    throw new OperationalReadError(400, "invalid_request", "Organization id is invalid.");
  }
  if (!invocation.scope.organizationId) {
    throw new OperationalReadError(
      400,
      "missing_scope",
      "The organization scope header is required.",
    );
  }
  if (invocation.scope.organizationId !== organizationId) {
    throw new OperationalReadError(
      403,
      "organization_scope_violation",
      "The organization scope header must match the organization path.",
    );
  }
  if (!exactGrant(invocation.identity.organizationIds, organizationId)) {
    throw new OperationalReadError(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  const organization = await getRecord(database, "control", {
    pk: key("ORG", organizationId),
    sk: key("ORG", organizationId),
  });
  if (organization?.itemType !== "organization") {
    throw new OperationalReadError(410, "organization_erased", "The organization has been erased.");
  }
  return organizationId;
}

async function getRecord(
  database: DynamoDatabaseService,
  table: "control" | "events",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return apiPersistence.read(database, table, recordKey, true);
}

async function environmentFor(
  database: DynamoDatabaseService,
  invocation: OperationalReadInvocation,
): Promise<Environment> {
  const environmentId = requiredEnvironmentId(invocation);
  const organizationId =
    invocation.identity.organizationIds !== "*" && invocation.identity.organizationIds?.length === 1
      ? invocation.identity.organizationIds[0]
      : undefined;
  const projectId =
    invocation.identity.projectIds !== "*" && invocation.identity.projectIds?.length === 1
      ? invocation.identity.projectIds[0]
      : undefined;
  if (organizationId && projectId) {
    const record = await getRecord(database, "control", {
      pk: key("ORG", organizationId, "PROJECT", projectId),
      sk: key("ENVIRONMENT", environmentId),
    });
    if (record?.itemType === "environment") return record;
  }
  const claim = await getRecord(database, "control", {
    pk: key("UNIQUE", "environment-id"),
    sk: key("VALUE", environmentId),
  });
  if (
    claim?.itemType !== "unique-claim" ||
    claim.data.ownerItemType !== "environment" ||
    claim.data.ownerId !== environmentId
  ) {
    throw new OperationalReadError(404, "not_found", "Environment was not found.");
  }
  const record = await getRecord(database, "control", {
    pk: claim.data.ownerPk,
    sk: claim.data.ownerSk,
  });
  if (record?.itemType !== "environment") {
    throw new OperationalReadError(404, "not_found", "Environment was not found.");
  }
  return record;
}

function recordTime(record: PlatformRecord) {
  const data = record.data as Readonly<Record<string, unknown>>;
  for (const field of ["occurredAt", "bucket", "periodStart", "createdAt", "updatedAt"]) {
    if (typeof data[field] === "string") return data[field] as string;
  }
  return undefined;
}

function matchesTime(record: PlatformRecord, since?: string, until?: string) {
  const time = recordTime(record);
  if (!time) return since === undefined && until === undefined;
  return (since === undefined || time >= since) && (until === undefined || time < until);
}

function cursorKey(value: unknown, partition: string, purpose: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const cursor = value as Readonly<Record<string, unknown>>;
  if (
    cursor.partition !== partition ||
    cursor.purpose !== purpose ||
    !cursor.key ||
    typeof cursor.key !== "object" ||
    Array.isArray(cursor.key)
  ) {
    throw new Error();
  }
  const keyValue = cursor.key as Readonly<Record<string, unknown>>;
  if (Object.keys(keyValue).toSorted().join(",") !== "pk,sk") throw new Error();
  for (const name of ["pk", "sk"] as const) {
    const part = keyValue[name];
    if (
      typeof part !== "string" ||
      !part ||
      new TextEncoder().encode(part).byteLength > MAX_KEY_BYTES[name]
    ) {
      throw new Error();
    }
  }
  if (keyValue.pk !== partition) throw new Error();
  return { pk: keyValue.pk as string, sk: keyValue.sk as string };
}

async function decodeCursor(
  value: unknown,
  partition: string,
  purpose: string,
  codec: OpaqueCursorCodec,
) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH) {
    throw new OperationalReadError(400, "invalid_cursor", "cursor is invalid.");
  }
  try {
    return cursorKey(JSON.parse(await codec.open(value)), partition, purpose);
  } catch {
    throw new OperationalReadError(400, "invalid_cursor", "cursor is invalid.");
  }
}

async function encodeCursor(
  keyValue: Readonly<Record<string, unknown>>,
  partition: string,
  purpose: string,
  codec: OpaqueCursorCodec,
) {
  return codec.seal(
    JSON.stringify({ key: { pk: keyValue.pk, sk: keyValue.sk }, partition, purpose }),
  );
}

/** A metric-index cursor names the environment partition, the list purpose, and its position. */
async function decodeMetricCursor(
  value: unknown,
  partition: string,
  environmentId: string,
  purpose: string,
  codec: OpaqueCursorCodec,
): Promise<MetricIndexPosition | undefined> {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH) throw new Error();
    return await openMetricCursor(codec, value, partition, environmentId, purpose);
  } catch {
    throw new OperationalReadError(400, "invalid_cursor", "cursor is invalid.");
  }
}

/** Plaintext that seals within MAX_CURSOR_LENGTH: 28 bytes of AES-GCM nonce and tag, base64url. */
const MAX_CURSOR_PLAINTEXT = Math.floor((MAX_CURSOR_LENGTH * 3) / 4) - 28;

type PartitionPageReader = (
  exclusiveStartKey: Readonly<Record<string, unknown>> | undefined,
  limit: number,
) => Promise<{
  readonly items: readonly PlatformRecord[];
  readonly lastEvaluatedKey?: Readonly<Record<string, unknown>>;
}>;

/**
 * The window, page size, and cursor purpose of a list request. The purpose binds a cursor to the
 * list and every filter it was issued for.
 */
function requestWindow(invocation: OperationalReadInvocation, purpose: string, maximumLimit = 100) {
  const since = canonicalTimestamp(invocation.query.since, "since");
  const until = canonicalTimestamp(invocation.query.until, "until");
  if (since && until && since >= until) {
    throw new OperationalReadError(400, "invalid_time_range", "since must be earlier than until.");
  }
  const cursorPurpose = `${purpose}:${createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(invocation.query)
          .filter(([name, value]) => name !== "cursor" && name !== "limit" && value !== undefined)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("base64url")}`;
  return { cursorPurpose, limit: pageLimit(invocation.query.limit, maximumLimit), since, until };
}

async function listPartition(
  partition: string,
  purpose: string,
  invocation: OperationalReadInvocation,
  matches: (record: PlatformRecord) => boolean,
  cursorCodec: OpaqueCursorCodec,
  readPage: PartitionPageReader,
) {
  const { cursorPurpose, limit, since, until } = requestWindow(invocation, purpose);
  const exclusiveStartKey = await decodeCursor(
    invocation.query.cursor,
    partition,
    cursorPurpose,
    cursorCodec,
  );
  const items: PlatformRecord[] = [];
  let nextKey: Readonly<Record<string, unknown>> | undefined = exclusiveStartKey;
  let physicalPages = 0;
  do {
    const result = await readPage(nextKey, limit - items.length);
    items.push(
      ...result.items.filter((record) => matches(record) && matchesTime(record, since, until)),
    );
    nextKey = result.lastEvaluatedKey;
    physicalPages += 1;
  } while (items.length < limit && nextKey && physicalPages < MAX_PHYSICAL_PAGES);
  return {
    items,
    ...(nextKey
      ? { nextCursor: await encodeCursor(nextKey, partition, cursorPurpose, cursorCodec) }
      : {}),
  };
}

function operationalRecord(record: UsageRecord | CostRecord | SpendRecord | ApiCredentialUsage) {
  return { data: { ...record.data }, type: record.itemType };
}

function usageRecord(record: UsageRecord) {
  if (
    record.itemType !== "meter-event" ||
    (record.data.dimensions.costUsdMicros === undefined &&
      record.data.dimensions.costUsdNanoDollars === undefined)
  ) {
    return operationalRecord(record);
  }
  const {
    costUsdMicros: _costUsdMicros,
    costUsdNanoDollars: _costUsdNanoDollars,
    ...dimensions
  } = record.data.dimensions;
  return {
    data: { ...record.data, dimensions },
    type: record.itemType,
  };
}

const decodeOperationalPage = Schema.decodeUnknownSync(
  OPERATIONS_API_SCHEMAS.OperationalRecordPageResponse,
);
const decodeAuditPage = Schema.decodeUnknownSync(OPERATIONS_API_SCHEMAS.AuditEventPageResponse);
const decodeUsageSummary = Schema.decodeUnknownSync(OPERATIONS_API_SCHEMAS.UsageSummaryResponse);
const decodeAuditEvent = Schema.decodeUnknownSync(OPERATIONS_API_SCHEMAS.AuditEventResponse);
const decodeOrganizationAuditPage = Schema.decodeUnknownSync(
  OPERATIONS_API_SCHEMAS.OrganizationAuditEventPageResponse,
);

function auditEvent(record: AuditEvent) {
  return {
    action: record.data.action,
    actor: record.data.actor,
    ...(record.data.changes ? { changes: record.data.changes } : {}),
    ...(record.data.environmentId ? { environmentId: record.data.environmentId } : {}),
    id: record.data.eventId,
    occurredAt: record.data.occurredAt,
    organizationId: record.data.organizationId,
    ...(record.data.projectId ? { projectId: record.data.projectId } : {}),
    ...(record.data.resourceId ? { resourceId: record.data.resourceId } : {}),
    ...(record.data.resourceType ? { resourceType: record.data.resourceType } : {}),
    ...(record.data.sourceIpHash ? { sourceIpHash: record.data.sourceIpHash } : {}),
    ...(record.data.userAgentHash ? { userAgentHash: record.data.userAgentHash } : {}),
  };
}

/** Shared `actor`, `resource`, and `event` filters of the environment and organization lists. */
function auditEventFilter(query: OperationalReadInvocation["query"]) {
  const { actor, event, resource } = query;
  return (record: PlatformRecord): record is AuditEvent =>
    record.itemType === "audit-event" &&
    (actor === undefined || (typeof actor === "string" && record.data.actor.id === actor)) &&
    (resource === undefined ||
      (typeof resource === "string" && record.data.resourceId === resource)) &&
    (event === undefined || (typeof event === "string" && record.data.action === event));
}

function environmentPartition(environment: Environment) {
  return key("ORG", environment.data.organizationId, "ENV", environment.data.id);
}

export function createOperationalReadService(
  options: OperationalReadServiceOptions,
): OperationalReadService {
  /** Environment audit events: the events table's environment partition, newest first. */
  const listEnvironmentEvents = async (
    invocation: OperationalReadInvocation,
    purpose: string,
    matches: (record: PlatformRecord) => boolean,
  ) => {
    const environment = await environmentFor(options.database, invocation);
    return listPartition(
      environmentPartition(environment),
      purpose,
      invocation,
      matches,
      options.cursorCodec,
      async (exclusiveStartKey, limit) =>
        apiPersistence.find(options.database, "events", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": environmentPartition(environment) },
          KeyConditionExpression: "#pk = :pk",
          Limit: limit,
          ScanIndexForward: false,
        }),
    );
  };

  /**
   * A usage, cost, spend, or API-key list read from the metric index over the request's window,
   * in pages of up to OPERATIONAL_RECORD_PAGE_LIMIT records.
   */
  const listByMetric = async (
    invocation: OperationalReadInvocation,
    purpose: string,
    metrics: (partition: string) => Promise<readonly string[]>,
    matches: (record: PlatformRecord) => boolean,
    windowed?: (metric: string) => boolean,
  ) => {
    const environment = await environmentFor(options.database, invocation);
    const partition = environmentPartition(environment);
    const { cursorPurpose, limit, since, until } = requestWindow(
      invocation,
      purpose,
      OPERATIONAL_RECORD_PAGE_LIMIT,
    );
    const start = await decodeMetricCursor(
      invocation.query.cursor,
      partition,
      environment.data.id,
      cursorPurpose,
      options.cursorCodec,
    );
    const page = await readMetricIndexPage({
      database: options.database,
      environmentId: environment.data.id,
      limit,
      matches: (record) => matches(record) && matchesTime(record, since, until),
      metrics: start?.metrics ?? (await metrics(partition)),
      since,
      start,
      until,
      ...(windowed ? { windowed } : {}),
    });
    return {
      items: page.items,
      ...(page.next
        ? {
            nextCursor: await sealMetricCursor(
              options.cursorCodec,
              page.next,
              partition,
              cursorPurpose,
              MAX_CURSOR_PLAINTEXT,
            ),
          }
        : {}),
    };
  };

  /** Usage or cost series of one environment, or of one agent's runs or workspace in it. */
  const summarize = async (invocation: OperationalReadInvocation, kind: "costs" | "usage") => {
    const environment = await environmentFor(options.database, invocation);
    const window = summaryWindow(invocation.query);
    const attribution = summaryAttribution(invocation.query);
    const summary = await readUsageSummary(
      options.database,
      {
        ...(attribution ? { attribution } : {}),
        environmentId: environment.data.id,
        partition: environmentPartition(environment),
      },
      window,
      kind,
    );
    return decodeUsageSummary({ ...window, ...summary });
  };

  return {
    getCostSummary: (invocation) => summarize(invocation, "costs"),
    getUsageSummary: (invocation) => summarize(invocation, "usage"),
    async getWorkspaceSpend(invocation) {
      return readWorkspaceSpend(options.database, {
        asOf: options.now?.() ?? new Date(),
        environment: await environmentFor(options.database, invocation),
        month: typeof invocation.query.month === "string" ? invocation.query.month : undefined,
        workspaceId: invocation.id,
      });
    },
    async listUsage(invocation) {
      const metric = invocation.query.metric;
      const page = await listByMetric(
        invocation,
        "usage-by-metric",
        (partition) => usageListMetrics(options.database, partition, metric),
        (record): record is UsageRecord =>
          (record.itemType === "meter-event" ||
            (record.itemType === "usage-counter-shard" && !isCostUsageMetric(record.data.metric)) ||
            (record.itemType === "usage-aggregate" && !isCostUsageMetric(record.data.metric)) ||
            record.itemType === "inbox-usage" ||
            record.itemType === "storage-usage") &&
          (metric === undefined ||
            (typeof metric === "string" &&
              "metric" in record.data &&
              record.data.metric === metric)),
      );
      return decodeOperationalPage({
        ...page,
        items: (page.items as readonly UsageRecord[]).map(usageRecord),
      });
    },
    async listCosts(invocation) {
      const page = await listByMetric(
        invocation,
        "costs-by-metric",
        (partition) => costListMetrics(options.database, partition),
        (record): record is CostRecord =>
          record.itemType === "cost-aggregate" ||
          ((record.itemType === "usage-counter-shard" || record.itemType === "usage-aggregate") &&
            isCostUsageMetric(record.data.metric)),
      );
      return decodeOperationalPage({
        ...page,
        items: (page.items as readonly CostRecord[]).map(operationalRecord),
      });
    },
    async listSpend(invocation) {
      // Billing periods are indexed by `updatedAt` but filtered by `periodStart`; there are few.
      const page = await listByMetric(
        invocation,
        "spend-by-metric",
        async () => ["provider-billing-period", "spend-ledger"],
        (record): record is SpendRecord =>
          record.itemType === "spend-ledger" || record.itemType === "provider-billing-period",
        (metric) => metric !== "provider-billing-period",
      );
      return decodeOperationalPage({
        ...page,
        items: (page.items as readonly SpendRecord[]).map(operationalRecord),
      });
    },
    async listApiCredentialUsage(invocation) {
      const apiCredentialId = invocation.query.apiCredentialId;
      const page = await listByMetric(
        invocation,
        "api-key-usage-by-metric",
        async () => ["api-credential-usage"],
        (record): record is ApiCredentialUsage =>
          record.itemType === "api-credential-usage" &&
          (apiCredentialId === undefined ||
            (typeof apiCredentialId === "string" &&
              record.data.apiCredentialId === apiCredentialId)),
      );
      return decodeOperationalPage({
        ...page,
        items: (page.items as readonly ApiCredentialUsage[]).map(operationalRecord),
      });
    },
    async listAuditEvents(invocation) {
      const page = await listEnvironmentEvents(
        invocation,
        "audit-events",
        auditEventFilter(invocation.query),
      );
      return decodeAuditPage({
        ...page,
        items: (page.items as readonly AuditEvent[]).map(auditEvent),
      });
    },
    async listOrganizationAuditEvents(invocation) {
      const organizationId = await requiredOrganizationId(options.database, invocation);
      const page = await listPartition(
        organizationAuditPartition(organizationId),
        "organization-audit-events",
        invocation,
        auditEventFilter(invocation.query),
        options.cursorCodec,
        async (exclusiveStartKey, limit) =>
          listOrganizationAuditEventPage(options.database, {
            ...(exclusiveStartKey ? { exclusiveStartKey: { ...exclusiveStartKey } } : {}),
            limit,
            organizationId,
          }),
      );
      return decodeOrganizationAuditPage({
        ...page,
        items: (page.items as readonly AuditEvent[]).map(auditEvent),
      });
    },
    async getAuditEvent(invocation) {
      const environment = await environmentFor(options.database, invocation);
      if (!invocation.id) {
        throw new OperationalReadError(400, "invalid_request", "Audit event id is required.");
      }
      const record = await getRecord(options.database, "events", {
        pk: environmentPartition(environment),
        sk: key("AUDIT-EVENT", invocation.id),
      });
      if (record?.itemType !== "audit-event") {
        throw new OperationalReadError(404, "not_found", "Audit event was not found.");
      }
      return decodeAuditEvent(auditEvent(record));
    },
  };
}
