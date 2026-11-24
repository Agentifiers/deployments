import {
  applyProviderAuthTransport,
  buildProviderClientCredentialsTokenRequest,
  parseProviderClientCredentialsTokenResponse,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import {
  executePinnedHttpsWithSameOriginRedirects,
  executePinnedHttpRequest,
  normalizeHttpsOriginForComparison,
  readResponseTextWithByteLimit,
  type DnsLookup,
  type ExecutePinnedHttpRequestOptions,
} from "@deployments-ai/net-security";
import { assertNoCredentialLeak } from "@deployments-ai/tools";

const MAX_VERIFICATION_RESPONSE_BYTES = 1_024 * 1_024;
const MAX_VERIFICATION_DURATION_MS = 20_000;

export interface AdministrationProviderVerificationInput {
  readonly connection: {
    readonly externalAccountId?: string;
    readonly externalAccountName?: string;
    readonly id: string;
    readonly scopes: readonly string[];
  };
  readonly credential: {
    readonly scopes?: readonly string[];
    readonly values: Readonly<Record<string, string>>;
  };
  readonly definition: ProviderDefinition;
}

export interface AdministrationProviderVerificationResult {
  readonly externalAccountId?: string;
  readonly externalAccountName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly scopes: readonly string[];
}

export interface AdministrationProviderVerificationPort {
  readonly verify: (
    input: AdministrationProviderVerificationInput,
  ) => Promise<AdministrationProviderVerificationResult>;
}

export interface AdministrationProviderVerifierOptions {
  readonly dnsLookup?: DnsLookup;
  readonly pinnedRequest?: (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;
}

export class AdministrationProviderVerificationError extends Error {
  readonly definitive: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AdministrationProviderVerificationError";
    this.definitive =
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      ![408, 409, 425, 429].includes(status);
  }
}

function pathValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Readonly<Record<string, unknown>>)[segment];
  }, value);
}

function verificationScopes(input: AdministrationProviderVerificationInput) {
  const granted = input.credential.scopes ?? input.connection.scopes;
  // API probe requiredScopes are prerequisites for that identity endpoint, not an exhaustive
  // statement of the credential's supported capabilities. Static credentials are verified as a
  // whole, while OAuth/manifest providers use their provider-granted scope evidence below.
  if (input.definition.authorizationScopeMode === "manifest") {
    return [...new Set(input.definition.defaultScopes)].toSorted();
  }
  if (
    input.definition.verification.method === "oauth_scopes" &&
    Object.keys(input.definition.authorizationScopeCapabilities).length > 0
  ) {
    return [
      ...new Set(
        granted.flatMap((scope) => input.definition.authorizationScopeCapabilities[scope] ?? []),
      ),
    ].toSorted();
  }
  return [
    ...new Set(granted.filter((scope) => input.definition.defaultScopes.includes(scope))),
  ].toSorted();
}

async function tokenExchange(
  definition: ProviderDefinition,
  fields: Readonly<Record<string, string>>,
  options: AdministrationProviderVerifierOptions,
  signal: AbortSignal,
) {
  const exchange = definition.auth.tokenExchange;
  if (!exchange) return undefined;
  const request = buildProviderClientCredentialsTokenRequest({ exchange, fields });
  const origin = normalizeHttpsOriginForComparison(new URL(request.endpoint).origin);
  const result = await executePinnedHttpsWithSameOriginRedirects({
    body: request.body,
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    headers: request.headers,
    maxRedirects: 0,
    method: request.method,
    pinnedRequest: options.pinnedRequest ?? executePinnedHttpRequest,
    signal,
    url: request.endpoint,
    verifiedOrigin: origin,
  });
  if (!result.response.ok) {
    try {
      await result.response.body?.cancel();
    } catch {
      // Preserve the authoritative token-exchange status when cleanup fails.
    }
    throw new AdministrationProviderVerificationError(
      `Provider token exchange returned HTTP ${result.response.status}.`,
      result.response.status,
    );
  }
  const body = await readResponseTextWithByteLimit(
    result.response,
    MAX_VERIFICATION_RESPONSE_BYTES,
    "Provider token exchange response",
  );
  return parseProviderClientCredentialsTokenResponse(JSON.parse(body)).accessToken;
}

export function makeAdministrationProviderVerifier(
  options: AdministrationProviderVerifierOptions = {},
): AdministrationProviderVerificationPort {
  return {
    async verify(input) {
      const verificationSignal = AbortSignal.timeout(MAX_VERIFICATION_DURATION_MS);
      const verification = input.definition.verification;
      if (verification.method === "oauth_scopes") {
        const scopes = verificationScopes(input);
        return {
          ...(input.connection.externalAccountId
            ? { externalAccountId: input.connection.externalAccountId }
            : {}),
          ...(input.connection.externalAccountName
            ? { externalAccountName: input.connection.externalAccountName }
            : {}),
          metadata: { method: verification.method },
          scopes,
        };
      }
      if (verification.method === "none") {
        return {
          metadata: { method: verification.method },
          scopes: verificationScopes(input),
        };
      }
      if (verification.method !== "api_probe" || !verification.probe) {
        throw new Error(`Provider verification method ${verification.method} is not executable.`);
      }

      const probe = verification.probe;
      let probeOrigin: string;
      if (input.definition.originPolicy) {
        const rawOrigin = input.credential.values[input.definition.originPolicy.fieldKey];
        if (!rawOrigin?.trim()) {
          throw new Error(
            `Provider credential is missing origin field ${input.definition.originPolicy.fieldKey}.`,
          );
        }
        probeOrigin = normalizeHttpsOriginForComparison(rawOrigin);
        const hostname = new URL(probeOrigin).hostname.toLowerCase();
        const allowedHosts = input.definition.apiHosts.map((value) => value.toLowerCase());
        const hostAllowed =
          allowedHosts.length === 0 ||
          allowedHosts.some((allowed) =>
            input.definition.originPolicy?.hostMatch === "suffix"
              ? hostname === allowed || hostname.endsWith(`.${allowed}`)
              : hostname === allowed,
          );
        if (!hostAllowed) {
          throw new Error("Provider credential origin is outside the provider allowlist.");
        }
      } else {
        const host = (probe.host ?? input.definition.apiHosts[0])?.toLowerCase();
        if (
          !host ||
          !input.definition.apiHosts.map((value) => value.toLowerCase()).includes(host)
        ) {
          throw new Error("Provider verification probe host is outside the provider allowlist.");
        }
        probeOrigin = `https://${host}`;
      }
      let path = probe.path;
      for (const fieldKey of probe.pathFieldKeys) {
        const value = input.credential.values[fieldKey]?.trim();
        if (!value) throw new Error(`Provider credential is missing probe field ${fieldKey}.`);
        path = path.replaceAll(`{${fieldKey}}`, encodeURIComponent(value));
      }
      const probeUrl = new URL(
        path.startsWith("/") ? path : `/${path}`,
        `${probeOrigin}/`,
      ).toString();
      const exchangedToken = await tokenExchange(
        input.definition,
        input.credential.values,
        options,
        verificationSignal,
      );
      const authenticated = input.definition.auth.transport
        ? applyProviderAuthTransport({
            fields: input.credential.values,
            transport: input.definition.auth.transport,
            url: probeUrl,
          })
        : { headers: {}, url: probeUrl };
      const headers = {
        accept: "application/json",
        ...probe.headers,
        ...authenticated.headers,
        ...(exchangedToken ? { authorization: `Bearer ${exchangedToken}` } : {}),
      };
      const origin = normalizeHttpsOriginForComparison(new URL(authenticated.url).origin);
      const result = await executePinnedHttpsWithSameOriginRedirects({
        ...(probe.body === undefined ? {} : { body: probe.body }),
        ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
        headers,
        maxRedirects: 0,
        method: probe.method,
        pinnedRequest: options.pinnedRequest ?? executePinnedHttpRequest,
        signal: AbortSignal.any([
          verificationSignal,
          AbortSignal.timeout(Math.min(probe.timeoutMs, MAX_VERIFICATION_DURATION_MS)),
        ]),
        url: authenticated.url,
        verifiedOrigin: origin,
      });
      if (!probe.expectedStatusCodes.includes(result.response.status)) {
        try {
          await result.response.body?.cancel();
        } catch {
          // Status classification is authoritative even when response cleanup fails.
        }
        throw new AdministrationProviderVerificationError(
          `Provider verification returned HTTP ${result.response.status}.`,
          result.response.status,
        );
      }
      const responseBody = await readResponseTextWithByteLimit(
        result.response,
        MAX_VERIFICATION_RESPONSE_BYTES,
        `${input.definition.displayName} verification response`,
      );
      let parsed: unknown;
      if (responseBody.trim()) {
        try {
          parsed = JSON.parse(responseBody);
        } catch {
          parsed = undefined;
        }
      }
      const identity = probe.identityIdPath
        ? pathValue(parsed, probe.identityIdPath)
        : input.connection.externalAccountId;
      if (
        probe.identityIdPath &&
        !(
          (typeof identity === "string" && identity.trim().length > 0) ||
          (typeof identity === "number" && Number.isFinite(identity))
        )
      ) {
        throw new Error(
          `Provider verification response omitted identity path ${probe.identityIdPath}.`,
        );
      }
      const sensitiveFields = input.definition.auth.fields
        .filter((field) => field.sensitive)
        .flatMap((field) => {
          const value = input.credential.values[field.key];
          return value ? [value] : [];
        });
      if (
        identity !== undefined &&
        (() => {
          try {
            assertNoCredentialLeak(
              JSON.stringify(identity),
              new Set([
                ...sensitiveFields,
                ...Object.values(authenticated.headers),
                ...(exchangedToken ? [exchangedToken] : []),
              ]),
              identity,
            );
            return false;
          } catch {
            return true;
          }
        })()
      ) {
        throw new Error("Provider verification response echoed credential material.");
      }
      return {
        ...(typeof identity === "string" || typeof identity === "number"
          ? { externalAccountId: String(identity).trim() }
          : {}),
        ...(input.connection.externalAccountName
          ? { externalAccountName: input.connection.externalAccountName }
          : {}),
        metadata: { method: verification.method, responseStatus: result.response.status },
        scopes: verificationScopes(input),
      };
    },
  };
}
