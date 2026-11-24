import type { KeyObject } from "node:crypto";
import {
  fundingForProvider,
  modelGatewayTokenAllowsModel,
  modelProviderForId,
  normalizeModelId,
  operatorFundingExhausted,
  operatorFundingExhaustedMessage,
  OrganizationModelKeyUnavailableError,
  verifyModelGatewayToken,
  type ModelFunding,
  type ModelGatewayTokenClaims,
  type ModelGatewayTokenVerification,
  type OperatorModelSpend,
  type OrganizationModelKeyResolver,
} from "@deployments-ai/model-gateway";
import { OperatorSpendUnavailableError, type OperatorSpendCheck } from "./operator-spend.ts";
import { RunStateUnavailableError, type RunActivityCheck } from "./run-activity.ts";
import { SigningKeyUnavailableError } from "./signing-keys.ts";
import {
  observeResponseBody,
  serviceUsageRecord,
  usageReader,
  type ObservedUsage,
  type StreamOutcome,
} from "./usage-record.ts";

export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** Non-2xx Bifrost bodies are buffered (to scrub secrets) up to this size. */
const MAX_UPSTREAM_ERROR_BODY_BYTES = 1024 * 1024;
const BIFROST_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Forwarded paths, and whether each serves embeddings. Embeddings stay operator-funded and are
 * never refused at the spend ceiling: stored vectors must not depend on a key the customer can
 * revoke or on a budget running out.
 */
const FORWARDED_PATHS: Record<string, { readonly embedding: boolean }> = {
  "/v1/chat/completions": { embedding: false },
  "/v1/embeddings": { embedding: true },
  // OpenAI Responses API: Firecrawl's AI SDK client sends its LLM calls here.
  "/v1/responses": { embedding: false },
};
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "x-bf-passthrough-extra-params"];
const REDACTED = "[redacted]";
/** Credential shapes a provider or Bifrost error might echo: `sk-…` API keys, bearer values, AWS access keys. */
const CREDENTIAL_PATTERN =
  /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[^\s"',]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
/**
 * Bifrost uses a direct key only when it is a single header token that does not look like a
 * virtual key. It serves any other value from the pool key without an error.
 */
const DIRECT_KEY_PATTERN = /^(?!sk-bf-)[\x21-\x7e]+$/iu;
/** Bifrost names the key that served a request in this header; a direct key is `header-provided`. */
const SERVING_KEY_HEADER = "x-bifrost-routing-info-key";
const DIRECT_KEY_NAME = "header-provided";

type GatewayLog = (entry: Record<string, unknown>) => void;

export interface ModelGatewayHandlerDependencies {
  readonly bifrostUrl: string;
  readonly internalVirtualKey: string;
  readonly log: GatewayLog;
  readonly operatorSpend: OperatorSpendCheck;
  /** Undefined refuses every organization-funded call. */
  readonly organizationKeys: OrganizationModelKeyResolver | undefined;
  readonly now: () => number;
  readonly publicKey: (keyId: string) => Promise<KeyObject | undefined>;
  readonly requestId: () => string;
  readonly runActivity: RunActivityCheck;
}

type ErrorCode =
  | "funding_mismatch"
  | "invalid_request"
  | "internal_error"
  | "missing_token"
  | "model_credential_store_unavailable"
  | "model_credential_unavailable"
  | "model_not_allowed"
  | "not_found"
  | "operator_funding_exhausted"
  | "operator_spend_unavailable"
  | "request_too_large"
  | "run_inactive"
  | "run_state_unavailable"
  | "signing_key_unavailable"
  | "upstream_unavailable"
  | (string & {});

/** What the request log may carry: identifiers only, never tokens, keys, or prompt content. */
interface RequestLogContext {
  code?: string;
  model?: string;
  token?: ModelGatewayTokenClaims;
}

class GatewayRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(status: number, code: ErrorCode, message: string) {
  return Response.json(
    { error: { code, message, type: "model_gateway_error" } },
    {
      status,
      // The rest of an oversized upload is never read, so the connection cannot be reused.
      headers: { "cache-control": "no-store", ...(status === 413 ? { connection: "close" } : {}) },
    },
  );
}

async function readBoundedBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    throw new GatewayRejection(413, "request_too_large", "Request body exceeds 32 MiB.");
  }
  if (!request.body)
    throw new GatewayRejection(400, "invalid_request", "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new GatewayRejection(413, "request_too_large", "Request body exceeds 32 MiB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function canonicalModelId(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayRejection(400, "invalid_request", `${field} must be a non-empty model id.`);
  }
  try {
    return normalizeModelId(value);
  } catch {
    throw new GatewayRejection(400, "invalid_request", `${field} is not a valid model id.`);
  }
}

/** Parses the request and rewrites `model`/`fallbacks` to the canonical ids that get authorized. */
function canonicalRequestBody(text: string) {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GatewayRejection(400, "invalid_request", "Request body must be JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayRejection(400, "invalid_request", "Request body must be a JSON object.");
  }
  // Bifrost reads body keys without regard to case, so `Fallbacks` would slip past these checks.
  const caseVariant = Object.keys(body).find(
    (key) => key !== key.toLowerCase() && ["fallbacks", "model"].includes(key.toLowerCase()),
  );
  if (caseVariant !== undefined) {
    throw new GatewayRejection(
      400,
      "invalid_request",
      `${caseVariant} must be spelled ${caseVariant.toLowerCase()}.`,
    );
  }
  const { fallbacks: requestedFallbacks, ...record } = body as Record<string, unknown>;
  const model = canonicalModelId(record.model, "model");
  if (requestedFallbacks !== undefined && !Array.isArray(requestedFallbacks)) {
    throw new GatewayRejection(400, "invalid_request", "fallbacks must be an array of model ids.");
  }
  const fallbacks = requestedFallbacks?.map((fallback: unknown, index: number) =>
    canonicalModelId(fallback, `fallbacks[${index}]`),
  );
  return { body: { ...record, model }, fallbacks, model };
}

function bearerToken(request: Request) {
  const match = /^Bearer\s+(\S+)$/iu.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!match?.[1]) throw new GatewayRejection(401, "missing_token", "A bearer token is required.");
  return match[1];
}

function scrubSecrets(text: string, secrets: readonly string[]) {
  return secrets
    .reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED), text)
    .replace(CREDENTIAL_PATTERN, REDACTED);
}

async function readUpstreamErrorBody(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.byteLength;
    if (size > MAX_UPSTREAM_ERROR_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

function tokenLogFields(claims: ModelGatewayTokenClaims | undefined) {
  if (!claims) return {};
  return claims.kind === "run"
    ? { organizationId: claims.organizationId, runId: claims.runId, tokenKind: "run" }
    : {
        ...(claims.organizationId ? { organizationId: claims.organizationId } : {}),
        service: claims.service,
        tokenKind: "service",
      };
}

export function createModelGatewayHandler(dependencies: ModelGatewayHandlerDependencies) {
  const { internalVirtualKey, log, now } = dependencies;

  async function health() {
    try {
      const response = await fetch(new URL("/health", dependencies.bifrostUrl), {
        signal: AbortSignal.timeout(BIFROST_HEALTH_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) return Response.json({ status: "ok" });
      log({ event: "model_gateway.health", level: "warn", upstreamStatus: response.status });
    } catch (cause) {
      log({ event: "model_gateway.health", level: "warn", reason: String(cause) });
    }
    return Response.json({ status: "unavailable" }, { status: 503 });
  }

  async function authenticate(request: Request) {
    const token = bearerToken(request);
    let verification: ModelGatewayTokenVerification;
    try {
      verification = await verifyModelGatewayToken(token, {
        now: now(),
        publicKey: dependencies.publicKey,
      });
    } catch (cause) {
      if (cause instanceof SigningKeyUnavailableError) {
        throw new GatewayRejection(502, "signing_key_unavailable", "Token keys are unavailable.");
      }
      throw cause;
    }
    if (!verification.ok) {
      throw new GatewayRejection(401, verification.reason, verification.message);
    }
    return verification.claims;
  }

  async function requireActiveRun(claims: ModelGatewayTokenClaims) {
    if (claims.kind !== "run") return;
    let active: boolean;
    try {
      active = await dependencies.runActivity(claims);
    } catch (cause) {
      if (cause instanceof RunStateUnavailableError) {
        throw new GatewayRejection(502, "run_state_unavailable", "Run state is unavailable.");
      }
      throw cause;
    }
    if (!active) {
      throw new GatewayRejection(403, "run_inactive", "The token's run no longer holds its lease.");
    }
  }

  async function requireOperatorFundingRoom(claims: ModelGatewayTokenClaims, model: string) {
    if (claims.organizationId === undefined) return;
    let spend: OperatorModelSpend;
    try {
      spend = await dependencies.operatorSpend(claims.organizationId);
    } catch (cause) {
      if (cause instanceof OperatorSpendUnavailableError) {
        throw new GatewayRejection(
          502,
          "operator_spend_unavailable",
          "Operator-funded model spend is unavailable.",
        );
      }
      throw cause;
    }
    if (operatorFundingExhausted(spend)) {
      throw new GatewayRejection(
        403,
        "operator_funding_exhausted",
        operatorFundingExhaustedMessage({
          modelId: model,
          organizationId: claims.organizationId,
          spend,
        }),
      );
    }
  }

  /** The organization's own provider key; organization funding never falls back to the pool key. */
  async function organizationKey(claims: ModelGatewayTokenClaims, funding: ModelFunding) {
    if (funding.kind === "operator") return undefined;
    let apiKey: string | undefined;
    try {
      apiKey =
        claims.organizationId === undefined
          ? undefined
          : await dependencies.organizationKeys?.resolve({
              credentialId: funding.credentialId,
              keyVersion: funding.keyVersion,
              organizationId: claims.organizationId,
              provider: funding.provider,
            });
    } catch (cause) {
      if (cause instanceof OrganizationModelKeyUnavailableError) {
        throw new GatewayRejection(
          502,
          "model_credential_store_unavailable",
          "Organization model credentials are unavailable.",
        );
      }
      throw cause;
    }
    if (apiKey === undefined || !DIRECT_KEY_PATTERN.test(apiKey)) {
      throw new GatewayRejection(
        401,
        "model_credential_unavailable",
        "The organization's model credential is unavailable.",
      );
    }
    return apiKey;
  }

  async function forward(
    request: Request,
    path: string,
    route: { readonly embedding: boolean },
    startedAt: number,
    context: RequestLogContext,
  ) {
    const claims = await authenticate(request);
    context.token = claims;
    const { body, fallbacks, model } = canonicalRequestBody(await readBoundedBody(request));
    context.model = model;
    const fundingClaim = route.embedding ? undefined : claims.funding;
    const funding = fundingForProvider(fundingClaim, modelProviderForId(model));
    // Bifrost serves every fallback attempt from its pool keys, so a request that names an
    // organization-funded provider anywhere goes out without fallbacks, and the token need not
    // carry the fallbacks it drops.
    const forwardedFallbacks =
      fallbacks !== undefined &&
      [model, ...fallbacks].every(
        (modelId) =>
          fundingForProvider(fundingClaim, modelProviderForId(modelId)).kind === "operator",
      )
        ? fallbacks
        : undefined;
    const denied = [model, ...(forwardedFallbacks ?? [])].find(
      (modelId) => !modelGatewayTokenAllowsModel(claims, modelId),
    );
    if (denied !== undefined) {
      throw new GatewayRejection(403, "model_not_allowed", `The token does not allow ${denied}.`);
    }
    await requireActiveRun(claims);
    if (!route.embedding && funding.kind === "operator") {
      await requireOperatorFundingRoom(claims, model);
    }

    const tenantKey = await organizationKey(claims, funding);
    const forwardedBody =
      forwardedFallbacks === undefined ? body : { ...body, fallbacks: forwardedFallbacks };
    const secrets =
      tenantKey === undefined ? [internalVirtualKey] : [internalVirtualKey, tenantKey];

    const headers = new Headers({ "x-bf-vk": internalVirtualKey });
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (tenantKey !== undefined) {
      headers.set("x-bf-direct-key", "true");
      headers.set("authorization", `Bearer ${tenantKey}`);
    }
    let upstream: Response;
    try {
      upstream = await fetch(new URL(path, dependencies.bifrostUrl), {
        body: JSON.stringify(forwardedBody),
        headers,
        method: "POST",
        redirect: "manual",
        signal: request.signal,
      });
    } catch {
      throw new GatewayRejection(502, "upstream_unavailable", "The model runtime is unavailable.");
    }
    if (
      tenantKey !== undefined &&
      upstream.ok &&
      upstream.headers.get(SERVING_KEY_HEADER) !== DIRECT_KEY_NAME
    ) {
      await upstream.body?.cancel();
      throw new GatewayRejection(
        502,
        "funding_mismatch",
        "The model runtime did not use the organization's key.",
      );
    }

    const contentType = upstream.headers.get("content-type");
    const responseHeaders = new Headers(contentType ? { "content-type": contentType } : {});
    const emitUsage = (outcome: StreamOutcome, usage: ObservedUsage | undefined) => {
      if (claims.kind !== "service") return;
      log(
        serviceUsageRecord({
          claims,
          durationMs: now() - startedAt,
          endpoint: path,
          model,
          outcome,
          status: upstream.status,
          timestamp: now(),
          usage,
        }),
      );
    };

    if (!upstream.ok) {
      const errorBody = await readUpstreamErrorBody(upstream);
      if (errorBody === undefined) {
        throw new GatewayRejection(502, "upstream_unavailable", "The model runtime failed.");
      }
      emitUsage("completed", undefined);
      return new Response(scrubSecrets(errorBody, secrets), {
        headers: responseHeaders,
        status: upstream.status,
      });
    }
    if (claims.kind === "run" || !upstream.body) {
      if (!upstream.body) emitUsage("completed", undefined);
      return new Response(upstream.body, { headers: responseHeaders, status: upstream.status });
    }
    const usage = usageReader(contentType);
    const observed = observeResponseBody(upstream.body, {
      chunk: usage.chunk,
      end: (outcome) => emitUsage(outcome, usage.usage()),
    });
    return new Response(observed, { headers: responseHeaders, status: upstream.status });
  }

  return async function handle(request: Request): Promise<Response> {
    const startedAt = now();
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/livez") return Response.json({ status: "ok" });
    if (request.method === "GET" && pathname === "/health") return health();

    const context: RequestLogContext = {};
    let response: Response;
    const route = request.method === "POST" ? FORWARDED_PATHS[pathname] : undefined;
    if (route === undefined) {
      context.code = "not_found";
      response = errorResponse(404, "not_found", "Not found.");
    } else {
      try {
        response = await forward(request, pathname, route, startedAt, context);
      } catch (cause) {
        if (cause instanceof GatewayRejection) {
          context.code = cause.code;
          response = errorResponse(cause.status, cause.code, cause.message);
        } else {
          context.code = "internal_error";
          log({
            error: cause instanceof Error ? cause.name : "unknown",
            event: "model_gateway.error",
            level: "error",
          });
          response = errorResponse(500, "internal_error", "The model gateway failed.");
        }
      }
    }
    log({
      ...(context.code ? { code: context.code } : {}),
      durationMs: now() - startedAt,
      event: "model_gateway.request",
      level: "info",
      method: request.method,
      ...(context.model ? { model: context.model } : {}),
      path: pathname,
      requestId: dependencies.requestId(),
      status: response.status,
      ...tokenLogFields(context.token),
    });
    return response;
  };
}
