export const runtimeItemErrors = [400, 401, 403, 404, 500] as const;
export const runtimeListErrors = [400, 401, 403, 500] as const;
export const runtimeFilteredListErrors = [400, 401, 403, 404, 500] as const;
export const runtimeMutationErrors = [400, 401, 403, 404, 409, 500] as const;
export const runtimeListQueryParameters = [
  {
    description: "Opaque cursor returned by the previous page.",
    name: "cursor",
    schema: { maxLength: 4_096, minLength: 1, type: "string" },
  },
  {
    description: "Maximum number of resources to return.",
    name: "limit",
    schema: { maximum: 100, minimum: 1, type: "integer" },
  },
] as const;
const executionBindingQueryParameter = {
  description:
    "Preview or evaluation execution binding whose resources should be returned. Resources of execution bindings are excluded unless this filter is set.",
  name: "executionBindingId",
  schema: { type: "string" },
} as const;
export const threadListQueryParameters = [
  ...runtimeListQueryParameters,
  executionBindingQueryParameter,
] as const;
const runStatusValues = [
  "canceled",
  "completed",
  "failed",
  "queued",
  "running",
  "waiting-for-approval",
  "waiting-for-tool",
] as const;
export const runListQueryParameters = [
  ...runtimeListQueryParameters,
  {
    description:
      "Agent deployment whose runs should be returned. At most one of agentDeploymentId and executionBindingId may be set; with neither, every run in the environment is returned newest first.",
    name: "agentDeploymentId",
    schema: { type: "string" },
  },
  {
    description:
      "Preview or evaluation execution binding whose runs should be returned. At most one of agentDeploymentId and executionBindingId may be set.",
    name: "executionBindingId",
    schema: { type: "string" },
  },
  {
    description: "Only return runs pinned to this agent release.",
    name: "agentReleaseId",
    schema: { type: "string" },
  },
  {
    description: "Only return runs in this status.",
    name: "status",
    schema: { enum: runStatusValues, type: "string" },
  },
  {
    description: "Only return runs executed for this purpose.",
    name: "executionPurpose",
    schema: { enum: ["customer", "evaluation", "preview"], type: "string" },
  },
  {
    description: "Only return runs of this thread.",
    name: "threadId",
    schema: { type: "string" },
  },
  {
    description: "Only return runs created at or after this canonical UTC millisecond timestamp.",
    name: "createdAfter",
    schema: { format: "date-time", type: "string" },
  },
  {
    description: "Only return runs created at or before this canonical UTC millisecond timestamp.",
    name: "createdBefore",
    schema: { format: "date-time", type: "string" },
  },
] as const;
export const approvalListQueryParameters = [
  ...runtimeListQueryParameters,
  {
    description: "Only return approvals in this status.",
    name: "status",
    schema: {
      enum: ["approved", "expired", "pending", "rejected"],
      type: "string",
    },
  },
] as const;
export const webhookDeliveryListQueryParameters = [
  ...runtimeListQueryParameters,
  {
    description: "Only return deliveries for this webhook subscription.",
    name: "webhookId",
    schema: { type: "string" },
  },
  {
    description: "Only return deliveries in this status.",
    name: "status",
    schema: {
      enum: ["delivered", "failed", "pending", "retrying", "sending"],
      type: "string",
    },
  },
] as const;
export const runtimeStreamQueryParameters = [
  {
    description: "Durable stream cursor from a previous read.",
    name: "cursor",
    schema: { minLength: 1, type: "string" },
  },
  {
    description:
      "Live mode: long-poll waits for the next events; sse holds a text/event-stream open that the server closes periodically, so reconnect from the last control offset. Omit for a catch-up read.",
    name: "live",
    schema: { enum: ["long-poll", "sse"], type: "string" },
  },
  {
    description: "Durable stream byte offset.",
    name: "offset",
    schema: { minLength: 1, type: "string" },
  },
] as const;
export const artifactListQueryParameters = [
  ...runtimeListQueryParameters,
  {
    description: "Return only artifacts produced by this run.",
    name: "runId",
    schema: { pattern: "^[0-9A-HJKMNP-TV-Z]{26}$", type: "string" },
  },
  {
    description: "Return only artifacts associated with runs in this thread.",
    name: "threadId",
    schema: { pattern: "^[0-9A-HJKMNP-TV-Z]{26}$", type: "string" },
  },
  {
    description: "Return only artifacts with this type label, such as report or input.",
    name: "type",
    schema: { maxLength: 100, minLength: 1, type: "string" },
  },
  {
    description:
      "Return only artifacts with this media type, compared without parameters, or in this family, such as image/*.",
    name: "contentType",
    schema: { maxLength: 255, minLength: 3, type: "string" },
  },
  {
    description:
      "Return only artifacts created at or after this canonical UTC millisecond timestamp.",
    name: "createdAfter",
    schema: { format: "date-time", type: "string" },
  },
  {
    description:
      "Return only artifacts created at or before this canonical UTC millisecond timestamp.",
    name: "createdBefore",
    schema: { format: "date-time", type: "string" },
  },
] as const;
