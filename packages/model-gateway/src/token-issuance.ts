import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import type { ModelGatewayServiceTokenContext } from "./gateway-token.ts";
import type { ModelGatewayCredentialRequest, ModelGatewayCredentials } from "./types.ts";

/** A worker's claim on a run: it holds the run's thread execution lease as `leaseOwner`. */
export interface ModelRunLease {
  readonly leaseOwner: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly threadId: string;
}

/**
 * Request to the run token issuer. The issuer reads the thread execution lease and the run, and
 * mints only while `leaseOwner` still holds the lease for `runId`.
 */
export interface ModelRunTokenRequest extends ModelRunLease {
  readonly kind: "run";
}

/**
 * Request to a service token issuer. Each service has its own issuer function, so the caller's IAM
 * identity selects the service. `models` beyond the service's configured models are admitted only
 * when the service may use tenant models and `context` names the environment. `run` marks a token
 * a running run needs: the issuer re-checks that claim as it does for run tokens and then admits
 * the token on the run's standing rather than the organization's.
 */
export interface ModelServiceTokenRequest {
  readonly context?: ModelGatewayServiceTokenContext;
  readonly kind: "service";
  readonly models?: readonly string[];
  readonly run?: ModelRunLease;
}

export type ModelTokenRequest = ModelRunTokenRequest | ModelServiceTokenRequest;

export type ModelTokenRefusal =
  | "invalid_request"
  | "lease_inactive"
  | "model_not_admitted"
  | "model_outside_data_boundary"
  | "operator_funding_exhausted"
  | "organization_suspended"
  | "run_not_found";

export type ModelTokenResponse =
  | {
      /** Epoch seconds. */
      readonly expiresAt: number;
      readonly models: readonly string[];
      readonly ok: true;
      readonly token: string;
    }
  | { readonly code: ModelTokenRefusal; readonly message: string; readonly ok: false };

export interface IssuedModelGatewayToken {
  /** Epoch seconds. */
  readonly expiresAt: number;
  readonly models: readonly string[];
  readonly token: string;
}

export class ModelTokenIssuanceError extends Error {
  constructor(
    readonly code: ModelTokenRefusal | "issuer_failed",
    message: string,
  ) {
    super(message);
    this.name = "ModelTokenIssuanceError";
  }
}

/** Decodes an issuer response, throwing a {@link ModelTokenIssuanceError} for refusals. */
export function issuedModelGatewayToken(value: unknown): IssuedModelGatewayToken {
  if (!value || typeof value !== "object") {
    throw new ModelTokenIssuanceError("issuer_failed", "Token issuer returned no response.");
  }
  const response = value as Record<string, unknown>;
  if (response.ok === false) {
    throw new ModelTokenIssuanceError(
      typeof response.code === "string" ? (response.code as ModelTokenRefusal) : "issuer_failed",
      typeof response.message === "string" ? response.message : "Token issuance was refused.",
    );
  }
  if (
    response.ok !== true ||
    typeof response.token !== "string" ||
    !Number.isSafeInteger(response.expiresAt) ||
    !Array.isArray(response.models) ||
    !response.models.every((model) => typeof model === "string")
  ) {
    throw new ModelTokenIssuanceError("issuer_failed", "Token issuer response is malformed.");
  }
  return {
    expiresAt: response.expiresAt as number,
    models: response.models as string[],
    token: response.token,
  };
}

/** Invokes an issuer Lambda function synchronously. Function errors surface as `issuer_failed`. */
export function lambdaModelTokenIssuer(client: Pick<LambdaClient, "send">, functionName: string) {
  return async (request: ModelTokenRequest): Promise<IssuedModelGatewayToken> => {
    const result = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    const payload = result.Payload ? Buffer.from(result.Payload).toString("utf8") : "";
    if (result.FunctionError) {
      throw new ModelTokenIssuanceError(
        "issuer_failed",
        `Token issuer failed (${result.FunctionError}).`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      throw new ModelTokenIssuanceError("issuer_failed", "Token issuer response is not JSON.");
    }
    return issuedModelGatewayToken(decoded);
  };
}

/** Tokens are refreshed this long before they expire. */
export const MODEL_GATEWAY_TOKEN_REFRESH_SECONDS = 120;
const MAX_CACHED_TOKENS = 256;

/**
 * A single-flight token cache keyed by issuance request: concurrent callers share one issuance,
 * and a token is reused until it is within the refresh window of its expiry. Failed issuances are
 * not cached.
 */
export function makeModelGatewayTokenCache(
  issue: (request: ModelTokenRequest) => Promise<IssuedModelGatewayToken>,
  now: () => number = Date.now,
) {
  const entries = new Map<string, Promise<IssuedModelGatewayToken>>();
  return async (request: ModelTokenRequest) => {
    const key = JSON.stringify(request);
    const cached = entries.get(key);
    if (cached) {
      const issued = await cached.catch(() => undefined);
      if (issued && issued.expiresAt - MODEL_GATEWAY_TOKEN_REFRESH_SECONDS > now() / 1000) {
        return issued.token;
      }
      if (entries.get(key) === cached) entries.delete(key);
    }
    const pending = issue(request);
    entries.set(key, pending);
    if (entries.size > MAX_CACHED_TOKENS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    try {
      return (await pending).token;
    } catch (cause) {
      if (entries.get(key) === pending) entries.delete(key);
      throw cause;
    }
  };
}

/**
 * The service token request covering a route's models: the primary first (the issuer decides
 * funding by it) and the fallbacks sorted so routes with the same primary and fallback set share a
 * token.
 */
export function modelServiceTokenRequest(
  modelIds: readonly string[],
  binding: {
    readonly context?: ModelGatewayServiceTokenContext;
    readonly run?: ModelRunLease;
  } = {},
): ModelServiceTokenRequest {
  const { context, run } = binding;
  const [primary, ...fallbacks] = new Set(modelIds);
  return {
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
    kind: "service",
    models: primary === undefined ? [] : [primary, ...fallbacks.toSorted()],
    ...(run ? { run } : {}),
  };
}

/**
 * Credentials for a platform service: each request asks for a {@link modelServiceTokenRequest}
 * token; `context` supplies the tenant context to attribute (and, for services allowed tenant
 * models, the environment whose policy admits them).
 */
export function modelGatewayServiceCredentials(input: {
  readonly context?: (
    request: ModelGatewayCredentialRequest,
  ) => ModelGatewayServiceTokenContext | undefined;
  readonly issue: (request: ModelTokenRequest) => Promise<IssuedModelGatewayToken>;
  readonly now?: () => number;
}): ModelGatewayCredentials {
  const tokens = makeModelGatewayTokenCache(input.issue, input.now);
  return (request) => {
    const context = input.context?.(request);
    return tokens(modelServiceTokenRequest(request.modelIds, context ? { context } : {}));
  };
}
