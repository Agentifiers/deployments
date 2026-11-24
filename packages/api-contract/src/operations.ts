import { Schema } from "effect";
import { Cursor, Metadata, PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract, PublicApiQueryParameter } from "./route-contract.ts";

export const OperationalRecordResponse = Schema.Struct({
  data: Metadata,
  type: Schema.String,
});

export const OperationalRecordPageResponse = Schema.Struct({
  items: Schema.Array(OperationalRecordResponse),
  nextCursor: Schema.optional(Cursor),
});

export const AuditActorResponse = Schema.Struct({
  id: Schema.optional(PublicId),
  operatorAccessGrantId: Schema.optional(PublicId).annotate({
    description:
      "Set when a platform administrator acted under operator access; the grant opened in this organization's audit log.",
  }),
  type: Schema.Literals([
    "agent",
    "directory-token",
    "principal",
    "service-account",
    "system",
    "worker",
  ]),
});

const auditEventFields = {
  action: Schema.String,
  actor: AuditActorResponse,
  changes: Schema.optional(Metadata),
  id: PublicId,
  occurredAt: Timestamp,
  organizationId: PublicId,
  resourceId: Schema.optional(PublicId),
  resourceType: Schema.optional(Schema.String),
  sourceIpHash: Schema.optional(Schema.String),
  userAgentHash: Schema.optional(Schema.String),
} as const;

export const AuditEventResponse = Schema.Struct({
  ...auditEventFields,
  environmentId: PublicId,
  projectId: PublicId,
});

export const AuditEventPageResponse = Schema.Struct({
  items: Schema.Array(AuditEventResponse),
  nextCursor: Schema.optional(Cursor),
});

/**
 * Organization-level administration. These events carry no environment; project and environment
 * lifecycle events name their project in `projectId` and the environment in `resourceId`.
 */
export const OrganizationAuditEventResponse = Schema.Struct({
  ...auditEventFields,
  projectId: Schema.optional(PublicId),
});

export const OrganizationAuditEventPageResponse = Schema.Struct({
  items: Schema.Array(OrganizationAuditEventResponse),
  nextCursor: Schema.optional(Cursor),
});

/** Records per page of the usage, cost, spend, and API-key lists. */
export const OPERATIONAL_RECORD_PAGE_LIMIT = 1_000;

export const USAGE_SUMMARY_INTERVALS = ["hour", "day"] as const;
/** Buckets one summary may hold: 31 days of hours, or 366 days. */
export const USAGE_SUMMARY_MAX_BUCKETS = { day: 366, hour: 744 } as const;
/** Token splits that model meter events record; counters hold only their total. */
export const USAGE_SUMMARY_TOKEN_PARTS = ["input", "output", "cached", "cache-write"] as const;

/**
 * One metric over a summary window. Quantity series carry the metric's own unit; cost series
 * carry `usd_nanodollars` and name the metric they cost (or a cost-aggregate source). `part`
 * marks a token split of the metric.
 */
export const UsageSummarySeries = Schema.Struct({
  kind: Schema.Literals(["cost", "quantity"]),
  metric: Schema.String,
  part: Schema.optional(Schema.Literals(USAGE_SUMMARY_TOKEN_PARTS)),
  total: Schema.Number,
  unit: Schema.String,
  /** One value per bucket, zero-filled. */
  values: Schema.Array(Schema.Number),
});

export const UsageSummaryResponse = Schema.Struct({
  /** Start of each bucket in `[since, until)`. */
  buckets: Schema.Array(Timestamp),
  interval: Schema.Literals(USAGE_SUMMARY_INTERVALS),
  series: Schema.Array(UsageSummarySeries),
  since: Timestamp,
  until: Timestamp,
});

export const OPERATIONS_API_SCHEMAS = {
  AuditActorResponse,
  AuditEventPageResponse,
  AuditEventResponse,
  OperationalRecordPageResponse,
  OperationalRecordResponse,
  OrganizationAuditEventPageResponse,
  OrganizationAuditEventResponse,
  UsageSummaryResponse,
  UsageSummarySeries,
} as const;

const cursor = {
  name: "cursor",
  schema: { maxLength: 4_096, minLength: 1, type: "string" },
} as const;
const limit = {
  name: "limit",
  schema: { maximum: 100, minimum: 1, type: "integer" },
} as const;
const since = {
  description: "Inclusive canonical UTC timestamp.",
  name: "since",
  schema: { format: "date-time", type: "string" },
} as const;
const until = {
  description: "Exclusive canonical UTC timestamp.",
  name: "until",
  schema: { format: "date-time", type: "string" },
} as const;
const timePageQuery = [cursor, limit, since, until] as const;
/** Ledger lists page larger: a window of usage is thousands of records. */
const recordPageQuery = [
  cursor,
  {
    name: "limit",
    schema: { maximum: OPERATIONAL_RECORD_PAGE_LIMIT, minimum: 1, type: "integer" },
  },
  since,
  until,
] as const;
const summaryQuery = [
  {
    description: "Inclusive canonical UTC timestamp on an interval boundary.",
    name: "since",
    required: true,
    schema: { format: "date-time", type: "string" },
  },
  {
    description: "Exclusive canonical UTC timestamp on an interval boundary.",
    name: "until",
    required: true,
    schema: { format: "date-time", type: "string" },
  },
  {
    description: `Bucket width (default hour). A summary holds at most ${USAGE_SUMMARY_MAX_BUCKETS.hour} hourly or ${USAGE_SUMMARY_MAX_BUCKETS.day} daily buckets.`,
    name: "interval",
    schema: { enum: USAGE_SUMMARY_INTERVALS, type: "string" },
  },
  {
    description:
      "Restrict the summary to usage of runs that executed this agent definition. Agent series come from the agent's own hourly counters; usage outside runs (inbox traffic, Brain operations) belongs to no agent. Not combinable with workspaceId.",
    name: "agentDefinitionId",
    schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
  },
  {
    description:
      "Restrict the summary to usage that names this workspace. Workspace series come from the workspace's own hourly counters, with token splits; usage without a workspace belongs to none. Not combinable with agentDefinitionId.",
    name: "workspaceId",
    schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
  },
] as const;
const auditQuery = [
  ...timePageQuery,
  { name: "actor", schema: { minLength: 1, type: "string" } },
  { name: "resource", schema: { minLength: 1, type: "string" } },
  { name: "event", schema: { minLength: 1, type: "string" } },
] as const;

function readRoute<
  const Route extends Omit<
    PublicApiRouteContract,
    "authentication" | "errors" | "idempotency" | "scopeHeaders" | "successStatus" | "tag"
  > & { readonly queryParameters?: readonly PublicApiQueryParameter[] },
>(
  route: Route,
): Route & {
  readonly authentication: "platform-bearer";
  readonly errors: readonly [400, 401, 403, 404, 422, 500];
  readonly idempotency: "none";
  readonly scopeHeaders: "environment";
  readonly successStatus: 200;
  readonly tag: "Operations";
} {
  return {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 422, 500],
    idempotency: "none",
    scopeHeaders: "environment",
    successStatus: 200,
    tag: "Operations",
    ...route,
  };
}

export const OPERATIONS_API_ROUTES = [
  readRoute({
    method: "GET",
    name: "listUsageRecords",
    path: "/v1/usage",
    queryParameters: [
      ...recordPageQuery,
      {
        description: "Restrict results to one metric.",
        name: "metric",
        schema: { minLength: 1, type: "string" },
      },
    ],
    requiredAuthorization: "usage:read",
    responseBody: "OperationalRecordPageResponse",
  }),
  readRoute({
    method: "GET",
    name: "getUsageSummary",
    path: "/v1/usage/summary",
    queryParameters: summaryQuery,
    requiredAuthorization: "usage:read",
    responseBody: "UsageSummaryResponse",
  }),
  readRoute({
    method: "GET",
    name: "listCostRecords",
    path: "/v1/costs",
    queryParameters: recordPageQuery,
    requiredAuthorization: "spend:read",
    responseBody: "OperationalRecordPageResponse",
  }),
  readRoute({
    method: "GET",
    name: "getCostSummary",
    path: "/v1/costs/summary",
    queryParameters: summaryQuery,
    requiredAuthorization: "spend:read",
    responseBody: "UsageSummaryResponse",
  }),
  readRoute({
    method: "GET",
    name: "listSpendRecords",
    path: "/v1/spend",
    queryParameters: recordPageQuery,
    requiredAuthorization: "spend:read",
    responseBody: "OperationalRecordPageResponse",
  }),
  readRoute({
    method: "GET",
    name: "listApiCredentialUsage",
    path: "/v1/api-key-usage",
    queryParameters: [
      ...recordPageQuery,
      {
        description: "Restrict results to one API credential.",
        name: "apiCredentialId",
        schema: { pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$", type: "string" },
      },
    ],
    requiredAuthorization: "api-keys:read",
    responseBody: "OperationalRecordPageResponse",
  }),
  readRoute({
    method: "GET",
    name: "listAuditEvents",
    path: "/v1/audit-events",
    queryParameters: auditQuery,
    requiredAuthorization: "audit:read",
    responseBody: "AuditEventPageResponse",
  }),
  readRoute({
    method: "GET",
    name: "getAuditEvent",
    path: "/v1/audit-events/:id",
    requiredAuthorization: "audit:read",
    responseBody: "AuditEventResponse",
  }),
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 410, 422, 500],
    idempotency: "none",
    method: "GET",
    name: "listOrganizationAuditEvents",
    path: "/v1/organizations/:id/audit-events",
    queryParameters: auditQuery,
    requiredAuthorization: "audit:read",
    responseBody: "OrganizationAuditEventPageResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Operations",
  },
] as const satisfies readonly PublicApiRouteContract[];
