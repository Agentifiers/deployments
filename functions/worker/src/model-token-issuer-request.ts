import { Ulid } from "@deployments-ai/db";
import {
  MODEL_GATEWAY_TOKEN_MAX_MODELS,
  type ModelGatewayServiceTokenContext,
  type ModelRunLease,
  type ModelRunTokenRequest,
  type ModelServiceTokenRequest,
} from "@deployments-ai/model-gateway";
import { Schema } from "effect";

/** Longest string a token claim may carry (mirrors the gateway's claim validation). */
const MAX_CLAIM_STRING_LENGTH = 512;

type AllowedFields = Readonly<Record<string, true>>;

const RUN_LEASE_FIELDS: AllowedFields = {
  leaseOwner: true,
  organizationId: true,
  runId: true,
  threadId: true,
};
const RUN_REQUEST_FIELDS: AllowedFields = { ...RUN_LEASE_FIELDS, kind: true };
const SERVICE_REQUEST_FIELDS: AllowedFields = {
  context: true,
  kind: true,
  models: true,
  run: true,
};
const SERVICE_CONTEXT_FIELDS: Readonly<Record<keyof ModelGatewayServiceTokenContext, true>> = {
  agentDefinitionId: true,
  environmentId: true,
  organizationId: true,
  projectId: true,
  runId: true,
  workspaceId: true,
};

export type ParsedModelTokenRequest<Request> =
  | { readonly ok: true; readonly request: Request }
  | { readonly message: string; readonly ok: false };

const isUlid = Schema.is(Ulid);

function invalid(message: string) {
  return { message, ok: false } as const;
}

/** Whether an issuer payload is a plain JSON object. */
export function isModelTokenRequestObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(value: Readonly<Record<string, unknown>>, allowed: AllowedFields) {
  return Object.keys(value).find((field) => !Object.hasOwn(allowed, field));
}

function claimString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && value.length <= MAX_CLAIM_STRING_LENGTH
  );
}

function parseRunLease(
  value: Readonly<Record<string, unknown>>,
  allowed: AllowedFields,
  subject: string,
): ParsedModelTokenRequest<ModelRunLease> {
  const extra = unknownField(value, allowed);
  if (extra !== undefined) return invalid(`${subject} do not accept field ${extra}.`);
  const { leaseOwner, organizationId, runId, threadId } = value;
  if (!isUlid(organizationId) || !isUlid(threadId) || !isUlid(runId)) {
    return invalid(`${subject} require ULID organizationId, threadId, and runId.`);
  }
  if (!claimString(leaseOwner)) return invalid(`${subject} require a non-empty leaseOwner.`);
  return { ok: true, request: { leaseOwner, organizationId, runId, threadId } };
}

/** Strictly decodes a run token request: exactly the run, thread, organization, and lease owner. */
export function parseModelRunTokenRequest(
  value: Readonly<Record<string, unknown>>,
): ParsedModelTokenRequest<ModelRunTokenRequest> {
  const parsed = parseRunLease(value, RUN_REQUEST_FIELDS, "Run token requests");
  return parsed.ok ? { ok: true, request: { kind: "run", ...parsed.request } } : parsed;
}

function parseServiceContext(
  value: unknown,
): ParsedModelTokenRequest<ModelGatewayServiceTokenContext> {
  if (!isModelTokenRequestObject(value)) {
    return invalid("Service token context must be an object.");
  }
  const extra = unknownField(value, SERVICE_CONTEXT_FIELDS);
  if (extra !== undefined) return invalid(`Service token context does not accept field ${extra}.`);
  const context: Record<string, string> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue;
    if (!claimString(fieldValue)) {
      return invalid(`Service token context field ${field} must be a non-empty string.`);
    }
    context[field] = fieldValue;
  }
  if (context.organizationId !== undefined && !isUlid(context.organizationId)) {
    return invalid("Service token context organizationId must be a ULID.");
  }
  return { ok: true, request: context };
}

/**
 * Strictly decodes a service token request: optional requested models, tenant context, and the run
 * claim the token serves, whose organization and run the context must name.
 */
export function parseModelServiceTokenRequest(
  value: Readonly<Record<string, unknown>>,
): ParsedModelTokenRequest<ModelServiceTokenRequest> {
  const extra = unknownField(value, SERVICE_REQUEST_FIELDS);
  if (extra !== undefined) return invalid(`Service token requests do not accept field ${extra}.`);
  const { models } = value;
  if (
    models !== undefined &&
    (!Array.isArray(models) ||
      models.length === 0 ||
      models.length > MODEL_GATEWAY_TOKEN_MAX_MODELS ||
      !models.every(claimString))
  ) {
    return invalid(
      `Service token requests must list 1 to ${MODEL_GATEWAY_TOKEN_MAX_MODELS} non-empty model ids when models is present.`,
    );
  }
  let context: ModelGatewayServiceTokenContext | undefined;
  if (value.context !== undefined) {
    const parsed = parseServiceContext(value.context);
    if (!parsed.ok) return parsed;
    context = parsed.request;
  }
  let run: ModelRunLease | undefined;
  if (value.run !== undefined) {
    if (!isModelTokenRequestObject(value.run))
      return invalid("Service token run must be an object.");
    const parsed = parseRunLease(value.run, RUN_LEASE_FIELDS, "Service token runs");
    if (!parsed.ok) return parsed;
    run = parsed.request;
    if (context?.organizationId !== run.organizationId || context.runId !== run.runId) {
      return invalid("Service token context must name the organization and run of its run.");
    }
  }
  return {
    ok: true,
    request: {
      kind: "service",
      ...(models !== undefined ? { models: models as string[] } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(run !== undefined ? { run } : {}),
    },
  };
}
