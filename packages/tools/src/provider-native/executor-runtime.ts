/* eslint-disable no-await-in-loop -- Provider retries and redirect-safe requests are ordered. */

import {
  applyProviderAuthTransport,
  buildProviderClientCredentialsTokenRequest,
  parseProviderClientCredentialsTokenResponse,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import {
  executePinnedHttpsWithSameOriginRedirects,
  executePinnedHttpRequest,
} from "@deployments-ai/net-security";
import { providerNativeRetryDecision } from "./core-request.ts";
import {
  PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY,
  type ProviderAccessToken,
  type ProviderNativeHttpToolDefinition,
} from "./core-types.ts";
import {
  DEFAULT_PROVIDER_NATIVE_REQUEST_MAX_BYTES,
  DEFAULT_PROVIDER_NATIVE_REQUEST_TIMEOUT_MS,
  DEFAULT_PROVIDER_NATIVE_RESPONSE_MAX_BYTES,
  DEFAULT_PROVIDER_NATIVE_TOKEN_RESPONSE_MAX_BYTES,
  DEFAULT_PROVIDER_NATIVE_USER_AGENT,
  ProviderNativeExecutionKnownFailureError,
  ProviderNativeExecutionOutcomeUnknownError,
  ProviderNativeExecutionRetryableError,
  ProviderNativeHttpResponseError,
  assertNoCredentialLeak,
  credentialLeakMaterials,
  definitiveProviderRejection,
  retryableProviderRejection,
  effectiveToolInput,
  firstCredentialField,
  jsonContentType,
  mergedCredentialFields,
  normalizedHeaders,
  parseResponseBody,
  positiveInteger,
  providerDefinitionForExecution,
  readUtf8Response,
  requestBody,
  staticCredentialToken,
  timeoutSignal,
  validateRequestUrl,
  validatedCredentialRequestHeaders,
  verifiedOrigin,
} from "./executor-request.ts";
import type {
  ExecuteProviderNativeHttpToolInput,
  ProviderNativeCredential,
  ProviderNativeHttpExecutionResult,
  ProviderNativeHttpExecutorOptions,
} from "./executor-request.ts";

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Provider request was aborted."));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Provider request was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pinnedRequest(args: {
  readonly body?: string | Uint8Array;
  readonly definition: ProviderNativeHttpToolDefinition;
  readonly headers: Record<string, string>;
  readonly options: ProviderNativeHttpExecutorOptions;
  readonly onDispatch: () => void;
  readonly requestUrl: string;
  readonly signal: AbortSignal;
  readonly verifiedOrigin: string;
}): Promise<Response> {
  const policy = args.definition.effect === "read" ? args.definition.retryPolicy : undefined;
  if (args.definition.retryResponse) {
    throw new Error(
      `${args.definition.toolName} uses an unsupported custom retry hook; use retryPolicy instead.`,
    );
  }
  const maximumAttempts = policy?.maxAttempts ?? 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const transport = args.options.pinnedRequest ?? executePinnedHttpRequest;
    const result = await executePinnedHttpsWithSameOriginRedirects({
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.options.dnsLookup ? { dnsLookup: args.options.dnsLookup } : {}),
      headers: args.headers,
      ...(args.definition.effect === "read"
        ? args.options.maxRedirects !== undefined
          ? { maxRedirects: args.options.maxRedirects }
          : {}
        : { maxRedirects: 0 }),
      method: args.definition.method,
      pinnedRequest: async (request) => {
        args.onDispatch();
        return transport(request);
      },
      signal: args.signal,
      url: args.requestUrl,
      verifiedOrigin: args.verifiedOrigin,
    });
    if (!policy) return result.response;
    const decision = providerNativeRetryDecision(
      policy,
      result.response,
      attempt,
      args.options.now?.() ?? Date.now(),
    );
    if (!decision.retry) return result.response;
    await result.response.body?.cancel();
    await (args.options.sleep ?? abortableSleep)(decision.delayMs, args.signal);
  }
  throw new Error(`${args.definition.toolName} exhausted its provider retry policy.`);
}

async function exchangeClientCredentials(args: {
  readonly credential: ProviderNativeCredential;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly options: ProviderNativeHttpExecutorOptions;
  readonly provider: ProviderDefinition;
  readonly signal: AbortSignal;
}): Promise<string> {
  const exchange = args.provider.auth.tokenExchange;
  if (!exchange) throw new Error(`${args.provider.key} does not define a token exchange.`);
  const request = buildProviderClientCredentialsTokenRequest({ exchange, fields: args.fields });
  const endpoint = validateRequestUrl({
    definition: {
      buildUrl: () => request.endpoint,
      defaultPolicyAction: "deny",
      description: `${args.provider.displayName} token exchange`,
      effect: "read",
      filePrefix: "token-exchange",
      hostPolicy: args.provider.hostPolicy,
      method: request.method,
      provider: args.provider.key,
      requiredScopes: [],
      toolName: `${args.provider.key}.token_exchange`,
    },
    provider: args.provider,
    requestUrl: request.endpoint,
  });
  const result = await executePinnedHttpsWithSameOriginRedirects({
    body: request.body,
    ...(args.options.dnsLookup ? { dnsLookup: args.options.dnsLookup } : {}),
    headers: { ...request.headers },
    ...(args.options.maxRedirects !== undefined ? { maxRedirects: args.options.maxRedirects } : {}),
    method: request.method,
    ...(args.options.pinnedRequest ? { pinnedRequest: args.options.pinnedRequest } : {}),
    signal: args.signal,
    url: endpoint.url,
    verifiedOrigin: endpoint.origin,
  });
  if (!result.response.ok) {
    await result.response.body?.cancel();
    throw new Error(
      `${args.provider.displayName} client-credentials exchange returned HTTP ${result.response.status}.`,
    );
  }
  const rawBody = await readUtf8Response(
    result.response,
    positiveInteger(
      args.options.maxTokenResponseBytes,
      DEFAULT_PROVIDER_NATIVE_TOKEN_RESPONSE_MAX_BYTES,
      "maxTokenResponseBytes",
    ),
    `${args.provider.displayName} client-credentials response`,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch (cause) {
    throw new Error(`${args.provider.displayName} client-credentials response was invalid JSON.`, {
      cause,
    });
  }
  return parseProviderClientCredentialsTokenResponse(parsed).accessToken;
}

function itemCount(value: unknown, depth = 0): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "data",
    "items",
    "results",
    "records",
    "files",
    "messages",
    "nodes",
    "values",
    "conversations",
    "tickets",
    "issues",
  ]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.length;
    const count = itemCount(nested, depth + 1);
    if (count !== undefined) return count;
  }
  return undefined;
}

function deepString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    let cursor = value;
    for (const segment of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (typeof cursor === "string" && cursor.trim()) return cursor.trim();
    if (typeof cursor === "number" && Number.isFinite(cursor)) return String(cursor);
  }
  return undefined;
}

function externalOperationId(value: unknown): string | undefined {
  return deepString(value, [
    ["id"],
    ["identifier"],
    ["node_id"],
    ["number"],
    ["ts"],
    ["message", "ts"],
    ["draft", "id"],
    ["file", "id"],
    ["issue", "id"],
    ["issue", "identifier"],
    ["issueCreate", "issue", "id"],
    ["issueCreate", "issue", "identifier"],
    ["data", "issueCreate", "issue", "id"],
    ["data", "issueCreate", "issue", "identifier"],
    ["ticket", "id"],
    ["conversation", "id"],
    ["content", "sha"],
    ["commit", "sha"],
    ["object", "sha"],
    ["ref"],
    ["documentId"],
    ["presentationId"],
    ["spreadsheetId"],
    ["data", "id"],
    ["Invoice", "Id"],
    ["Task", "Id"],
  ]);
}

function outboundMutation(definition: ProviderNativeHttpToolDefinition): boolean {
  return definition.effect !== "read" || definition.effectMetadata?.outboundMutation === true;
}

export function providerNativeTransportInput(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const transportInput = { ...input };
  delete transportInput[PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY];
  return transportInput;
}

export async function executeProviderNativeHttpTool(
  input: ExecuteProviderNativeHttpToolInput,
  options: ProviderNativeHttpExecutorOptions = {},
): Promise<ProviderNativeHttpExecutionResult> {
  let providerRequestDispatched = false;
  let cleanupTimeout: (() => void) | undefined;
  try {
    if (input.request.toolName !== input.definition.toolName) {
      throw new Error("Provider-native request tool name does not match its definition.");
    }
    const provider = providerDefinitionForExecution(input.definition, input.credential);
    const fields = mergedCredentialFields(provider, input.credential);
    const effectiveInput = effectiveToolInput(
      providerNativeTransportInput(input.input),
      input.credential,
      provider,
      fields,
    );
    const requiredInputScopes = [
      ...new Set(
        (input.definition.requiredScopesForInput?.(effectiveInput) ?? []).map((scope) => {
          const normalized = scope.trim();
          if (!normalized) {
            throw new Error(
              `${input.definition.toolName} returned an invalid input-specific scope requirement.`,
            );
          }
          return normalized;
        }),
      ),
    ];
    const grantedScopes = new Set(
      (input.credential.grantedScopes ?? []).map((scope) => scope.trim()).filter(Boolean),
    );
    if (requiredInputScopes.some((scope) => !grantedScopes.has(scope))) {
      throw new Error(
        `${input.definition.toolName} credential is missing required input-specific scopes.`,
      );
    }
    const requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_PROVIDER_NATIVE_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    const timed = timeoutSignal(input.signal, requestTimeoutMs);
    cleanupTimeout = timed.cleanup;
    const exchangedToken = provider.auth.tokenExchange
      ? await exchangeClientCredentials({
          credential: input.credential,
          fields,
          options,
          provider,
          signal: timed.signal,
        })
      : undefined;
    const tokenValue =
      exchangedToken ??
      (provider.route === "platform_oauth"
        ? firstCredentialField(fields, ["accessToken", "access_token", "token", "apiKey"])
        : staticCredentialToken(provider, fields));
    if (!tokenValue) throw new Error(`${provider.key} credential did not include an access token.`);
    const token: ProviderAccessToken = {
      externalAccountId: input.credential.externalAccountId.trim(),
      provider: provider.key,
      token: tokenValue,
    };
    if (!token.externalAccountId) {
      throw new Error("Provider credential externalAccountId is required.");
    }

    const body = input.definition.buildBody?.(effectiveInput, token, input.request);
    const builtUrl = input.definition.buildUrl(effectiveInput, token, input.request);
    const transported = provider.auth.transport
      ? applyProviderAuthTransport({ fields, transport: provider.auth.transport, url: builtUrl })
      : { headers: {}, url: builtUrl };
    const authHeaders = provider.auth.tokenExchange
      ? { ...transported.headers, authorization: `Bearer ${token.token}` }
      : provider.route === "platform_oauth"
        ? { authorization: `Bearer ${token.token}` }
        : transported.headers;
    const requestUrl = transported.url;
    const pinnedOrigin = verifiedOrigin(input.definition, provider, fields);
    const validatedUrl = validateRequestUrl({
      definition: input.definition,
      provider,
      requestUrl,
      ...(pinnedOrigin ? { verifiedOrigin: pinnedOrigin } : {}),
    });
    const headers = normalizedHeaders({
      accept: "application/json",
      ...authHeaders,
      ...(body?.contentType ? { "content-type": body.contentType } : {}),
      ...(outboundMutation(input.definition)
        ? { "idempotency-key": input.request.idempotencyKey }
        : {}),
      "user-agent": options.userAgent ?? DEFAULT_PROVIDER_NATIVE_USER_AGENT,
      ...input.definition.buildHeaders?.(effectiveInput, token),
      ...validatedCredentialRequestHeaders(input.credential.requestHeaders),
    });
    const boundedBody = requestBody(
      body,
      positiveInteger(
        options.maxRequestBytes,
        DEFAULT_PROVIDER_NATIVE_REQUEST_MAX_BYTES,
        "maxRequestBytes",
      ),
      input.definition.toolName,
    );
    const response = await pinnedRequest({
      ...(boundedBody !== undefined ? { body: boundedBody } : {}),
      definition: input.definition,
      headers,
      onDispatch: () => {
        providerRequestDispatched = true;
      },
      options,
      requestUrl: validatedUrl.url,
      signal: timed.signal,
      verifiedOrigin: pinnedOrigin ?? validatedUrl.origin,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderNativeHttpResponseError(provider.key, response.status);
    }
    const rawBody = await readUtf8Response(
      response,
      positiveInteger(
        options.maxResponseBytes,
        DEFAULT_PROVIDER_NATIVE_RESPONSE_MAX_BYTES,
        "maxResponseBytes",
      ),
      `${input.definition.toolName} provider response`,
    );
    const contentType = response.headers.get("content-type") ?? "";
    const parsedBody = parseResponseBody(
      rawBody,
      contentType,
      `${input.definition.toolName} provider response`,
    );
    input.definition.validateResponse?.(response, parsedBody, effectiveInput, token);
    const artifactBody =
      jsonContentType(contentType) && parsedBody !== undefined
        ? JSON.stringify(parsedBody, null, 2)
        : rawBody;
    assertNoCredentialLeak(
      `${rawBody}\n${artifactBody}`,
      credentialLeakMaterials({
        authHeaders,
        credential: input.credential,
        fields,
        provider,
        token,
      }),
      parsedBody,
    );
    const count = itemCount(parsedBody);
    const summary =
      input.definition.successSummary?.(response, effectiveInput, token) ??
      `${input.definition.toolName} completed with status ${response.status}.`;
    return {
      artifactBody,
      contentType,
      ...(outboundMutation(input.definition) && externalOperationId(parsedBody)
        ? { externalOperationId: externalOperationId(parsedBody)! }
        : {}),
      ...(count === undefined ? {} : { itemCount: count }),
      outputSummary: count === undefined ? summary : `${summary} ${count} item(s) returned.`,
      parsedBody,
      provider: provider.key,
      requestHost: new URL(validatedUrl.url).hostname,
      responseStatus: response.status,
      sourceCharacterCount: rawBody.length,
    };
  } catch (cause) {
    const retryableStatusCodes =
      !outboundMutation(input.definition) && input.definition.retryPolicy
        ? input.definition.retryPolicy.retryableStatusCodes
        : undefined;
    if (retryableProviderRejection(cause, retryableStatusCodes)) {
      throw new ProviderNativeExecutionRetryableError(input.definition.toolName, cause);
    }
    if (
      cause instanceof ProviderNativeExecutionKnownFailureError ||
      !outboundMutation(input.definition) ||
      !providerRequestDispatched ||
      definitiveProviderRejection(cause)
    ) {
      throw cause instanceof ProviderNativeExecutionKnownFailureError
        ? cause
        : new ProviderNativeExecutionKnownFailureError(input.definition.toolName, cause);
    }
    throw cause instanceof ProviderNativeExecutionOutcomeUnknownError
      ? cause
      : new ProviderNativeExecutionOutcomeUnknownError(input.definition.toolName, cause);
  } finally {
    cleanupTimeout?.();
  }
}
