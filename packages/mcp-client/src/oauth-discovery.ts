import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  oauthHttpContext,
  parseHttpsUrl,
  parseJsonObject,
  pinnedOAuthRequest,
  type OAuthHttpContext,
  type OAuthHttpInput,
} from "./oauth-pinned-http.ts";
import { parseWwwAuthenticate } from "./oauth-www-authenticate.ts";

export type McpAuthorizationDiscoveryErrorCode =
  | "authorization_server_metadata"
  | "issuer_mismatch"
  | "network"
  | "protected_resource_metadata";

export class McpAuthorizationDiscoveryError extends Error {
  constructor(
    readonly code: McpAuthorizationDiscoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpAuthorizationDiscoveryError";
  }
}

export interface McpDiscoveredAuthorization {
  readonly challenge: { readonly resourceMetadataUrl?: string; readonly scope?: string };
  readonly protectedResource?: {
    readonly resource: string;
    readonly authorizationServers: readonly string[];
    readonly scopesSupported?: readonly string[];
    readonly metadataUrl: string;
  };
  readonly authorizationServer: {
    readonly issuer: string;
    readonly metadataUrl: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly registrationEndpoint?: string;
    readonly revocationEndpoint?: string;
    readonly clientIdMetadataDocumentSupported: boolean;
    readonly codeChallengeMethodsSupported: readonly string[];
    readonly tokenEndpointAuthMethodsSupported: readonly string[];
    readonly authorizationResponseIssParameterSupported: boolean;
    readonly scopesSupported?: readonly string[];
  };
}

export interface DiscoverMcpAuthorizationInput extends OAuthHttpInput {
  /**
   * Reviewed AS metadata location for vendors whose metadata `issuer` differs from the PRM
   * identifier. When set, AS metadata is fetched only from this URL and its `issuer` must
   * equal `expectedIssuer` verbatim; `pinnedIssuer` is neither required nor matched.
   */
  readonly authorizationServerMetadataUrl?: string;
  /** Required with `authorizationServerMetadataUrl`: the exact metadata `issuer` string. */
  readonly expectedIssuer?: string;
  readonly mcpUrl: string;
  /**
   * Preferred issuer when the PRM lists several; required when PRM is `absent` unless
   * `authorizationServerMetadataUrl` is set.
   */
  readonly pinnedIssuer?: string;
  /** `absent`: the server predates RFC 9728; skip PRM and use the pinned AS directly. */
  readonly protectedResourceMetadata: "absent" | "published";
}

type ProtectedResource = NonNullable<McpDiscoveredAuthorization["protectedResource"]>;
type AuthorizationServer = McpDiscoveredAuthorization["authorizationServer"];
type DocumentOutcome =
  | { readonly document: Readonly<Record<string, unknown>>; readonly kind: "document" }
  | { readonly kind: "rejected"; readonly reason: string };

const JSON_HEADERS = { accept: "application/json" };

function fail(code: McpAuthorizationDiscoveryErrorCode, message: string): never {
  throw new McpAuthorizationDiscoveryError(code, message);
}

async function fetchJsonDocument(context: OAuthHttpContext, url: URL): Promise<DocumentOutcome> {
  const outcome = await pinnedOAuthRequest(context, {
    headers: JSON_HEADERS,
    method: "GET",
    readBody: true,
    url,
  });
  if (outcome.kind === "redirect") return { kind: "rejected", reason: `${url.href} redirected` };
  if (outcome.kind === "too-large") {
    return { kind: "rejected", reason: `${url.href} exceeded the 64 KiB metadata limit` };
  }
  if (outcome.status !== 200) {
    return { kind: "rejected", reason: `${url.href} returned HTTP ${outcome.status}` };
  }
  const document = parseJsonObject(outcome.body);
  return document
    ? { document, kind: "document" }
    : { kind: "rejected", reason: `${url.href} did not return a JSON object` };
}

function optionalStrings(
  document: Readonly<Record<string, unknown>>,
  field: string,
  code: McpAuthorizationDiscoveryErrorCode,
): readonly string[] | undefined {
  const value = document[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    fail(code, `Metadata field ${field} must be an array of strings.`);
  }
  return value as readonly string[];
}

function optionalBoolean(document: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = document[field];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    fail("authorization_server_metadata", `Metadata field ${field} must be a boolean.`);
  }
  return value;
}

function endpoint(
  document: Readonly<Record<string, unknown>>,
  field: string,
  required: boolean,
): string | undefined {
  const value = document[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !parseHttpsUrl(value)) {
    fail("authorization_server_metadata", `Metadata field ${field} must be an absolute HTTPS URL.`);
  }
  return value;
}

/** Unauthenticated `initialize`; returns the Bearer challenge parameters from a 401. */
async function probeChallenge(
  context: OAuthHttpContext,
  mcpUrl: URL,
): Promise<McpDiscoveredAuthorization["challenge"]> {
  const outcome = await pinnedOAuthRequest(context, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "deployments-ai-oauth-discovery", version: "1.0.0" },
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
    readBody: false,
    url: mcpUrl,
  });
  if (outcome.kind !== "response" || outcome.status !== 401) return {};
  const header = outcome.headers.get("www-authenticate");
  if (!header) return {};
  const challenges = parseWwwAuthenticate(header);
  const challenge =
    challenges.find((entry) => entry.scheme === "bearer") ??
    challenges.find((entry) => entry.params.has("resource_metadata"));
  const resourceMetadataUrl = challenge?.params.get("resource_metadata");
  const scope = challenge?.params.get("scope");
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
  };
}

function parseProtectedResource(
  document: Readonly<Record<string, unknown>>,
  metadataUrl: string,
): ProtectedResource {
  const resource = document.resource;
  const servers = document.authorization_servers;
  if (typeof resource !== "string" || !resource) {
    fail("protected_resource_metadata", `${metadataUrl} has no resource identifier.`);
  }
  if (
    !Array.isArray(servers) ||
    servers.length === 0 ||
    !servers.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    fail(
      "protected_resource_metadata",
      `${metadataUrl} must list authorization_servers as a non-empty string array.`,
    );
  }
  const scopesSupported = optionalStrings(
    document,
    "scopes_supported",
    "protected_resource_metadata",
  );
  return {
    authorizationServers: servers as readonly string[],
    metadataUrl,
    resource,
    ...(scopesSupported ? { scopesSupported } : {}),
  };
}

/**
 * RFC 9728 lookup: the challenge `resource_metadata` URL when present, else the
 * path-inserted well-known URI followed by the root well-known URI.
 */
async function fetchProtectedResource(
  context: OAuthHttpContext,
  mcpUrl: URL,
  challenge: McpDiscoveredAuthorization["challenge"],
): Promise<ProtectedResource> {
  let candidates: readonly URL[];
  if (challenge.resourceMetadataUrl) {
    const headerUrl = parseHttpsUrl(challenge.resourceMetadataUrl);
    if (!headerUrl) {
      fail(
        "protected_resource_metadata",
        "WWW-Authenticate resource_metadata must be an HTTPS URL.",
      );
    }
    candidates = [headerUrl];
  } else {
    const path = mcpUrl.pathname.replace(/\/+$/, "");
    const root = new URL("/.well-known/oauth-protected-resource", mcpUrl.origin);
    candidates = path
      ? [new URL(`/.well-known/oauth-protected-resource${path}`, mcpUrl.origin), root]
      : [root];
  }
  const rejections: string[] = [];
  for (const candidate of candidates) {
    const outcome = await fetchJsonDocument(context, candidate);
    if (outcome.kind === "document")
      return parseProtectedResource(outcome.document, candidate.toString());
    rejections.push(outcome.reason);
  }
  return fail(
    "protected_resource_metadata",
    `Protected resource metadata unavailable: ${rejections.join("; ")}.`,
  );
}

/** RFC 8414 §3.1 and OIDC Discovery candidate URLs, in MCP-specified priority order. */
function authorizationServerMetadataUrls(issuer: URL): readonly URL[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  if (!path) {
    return [
      new URL("/.well-known/oauth-authorization-server", issuer.origin),
      new URL("/.well-known/openid-configuration", issuer.origin),
    ];
  }
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
  ];
}

function parseAuthorizationServer(
  document: Readonly<Record<string, unknown>>,
  issuer: string,
  metadataUrl: string,
): AuthorizationServer {
  const registrationEndpoint = endpoint(document, "registration_endpoint", false);
  const revocationEndpoint = endpoint(document, "revocation_endpoint", false);
  const scopesSupported = optionalStrings(
    document,
    "scopes_supported",
    "authorization_server_metadata",
  );
  return {
    authorizationEndpoint: endpoint(document, "authorization_endpoint", true)!,
    authorizationResponseIssParameterSupported: optionalBoolean(
      document,
      "authorization_response_iss_parameter_supported",
    ),
    clientIdMetadataDocumentSupported: optionalBoolean(
      document,
      "client_id_metadata_document_supported",
    ),
    codeChallengeMethodsSupported:
      optionalStrings(
        document,
        "code_challenge_methods_supported",
        "authorization_server_metadata",
      ) ?? [],
    issuer,
    metadataUrl,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(scopesSupported ? { scopesSupported } : {}),
    tokenEndpoint: endpoint(document, "token_endpoint", true)!,
    // RFC 8414 §2: omitted means client_secret_basic.
    tokenEndpointAuthMethodsSupported: optionalStrings(
      document,
      "token_endpoint_auth_methods_supported",
      "authorization_server_metadata",
    ) ?? ["client_secret_basic"],
  };
}

/**
 * Issuer identifier comparison used for RFC 8414 validation and PRM matching. Identical
 * strings are equal; otherwise two identifiers are equal only when both are HTTPS URLs
 * with the same origin, an empty or "/" path, and no query or fragment (the common
 * `https://accounts.google.com/` vs `https://accounts.google.com` interop difference).
 */
export function mcpIssuerIdentifiersEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const rootOrigin = (value: string) => {
    if (/[?#]/.test(value)) return undefined;
    const url = parseHttpsUrl(value);
    return url && url.pathname === "/" ? url.origin : undefined;
  };
  const left = rootOrigin(a);
  return left !== undefined && left === rootOrigin(b);
}

async function fetchAuthorizationServer(
  context: OAuthHttpContext,
  issuer: string,
): Promise<AuthorizationServer> {
  const issuerUrl = parseHttpsUrl(issuer);
  if (!issuerUrl || issuerUrl.search) {
    fail(
      "authorization_server_metadata",
      `Issuer ${issuer} must be an HTTPS URL without query or fragment.`,
    );
  }
  const rejections: string[] = [];
  let mismatchedIssuer = false;
  for (const candidate of authorizationServerMetadataUrls(issuerUrl)) {
    const outcome = await fetchJsonDocument(context, candidate);
    if (outcome.kind === "rejected") {
      rejections.push(outcome.reason);
      continue;
    }
    const documentIssuer = outcome.document.issuer;
    if (
      typeof documentIssuer !== "string" ||
      !mcpIssuerIdentifiersEquivalent(documentIssuer, issuer)
    ) {
      mismatchedIssuer = true;
      rejections.push(`${candidate.href} describes a different issuer`);
      continue;
    }
    return parseAuthorizationServer(outcome.document, documentIssuer, candidate.toString());
  }
  return fail(
    mismatchedIssuer ? "issuer_mismatch" : "authorization_server_metadata",
    `Authorization server metadata for ${issuer} unavailable: ${rejections.join("; ")}.`,
  );
}

/** Reviewed-pin mode: one exact metadata URL whose `issuer` must match verbatim. */
async function fetchPinnedAuthorizationServer(
  context: OAuthHttpContext,
  metadataUrl: URL,
  expectedIssuer: string,
): Promise<AuthorizationServer> {
  const outcome = await fetchJsonDocument(context, metadataUrl);
  if (outcome.kind === "rejected") {
    fail(
      "authorization_server_metadata",
      `Authorization server metadata unavailable: ${outcome.reason}.`,
    );
  }
  if (outcome.document.issuer !== expectedIssuer) {
    fail("issuer_mismatch", `${metadataUrl.href} does not describe issuer ${expectedIssuer}.`);
  }
  return parseAuthorizationServer(outcome.document, expectedIssuer, metadataUrl.toString());
}

/**
 * MCP authorization discovery (spec 2026-07-28): RFC 9728 protected resource metadata via
 * the 401 challenge or well-known fallback, then RFC 8414 / OIDC authorization server
 * metadata whose `issuer` must match the requested issuer (see
 * `mcpIssuerIdentifiersEquivalent`), or a reviewed pinned metadata URL whose `issuer` must
 * equal `expectedIssuer` verbatim. Every request is DNS-pinned HTTPS, never follows
 * redirects, and reads at most 64 KiB.
 */
export async function discoverMcpAuthorization(
  input: DiscoverMcpAuthorizationInput,
): Promise<McpDiscoveredAuthorization> {
  const mcpUrl = parseHttpsUrl(input.mcpUrl);
  if (!mcpUrl) fail("network", "MCP URL must be an absolute HTTPS URL.");
  let pinnedMetadata: { readonly expectedIssuer: string; readonly url: URL } | undefined;
  if (input.authorizationServerMetadataUrl !== undefined) {
    const url = parseHttpsUrl(input.authorizationServerMetadataUrl);
    if (!url) {
      fail(
        "authorization_server_metadata",
        "Pinned authorization server metadata URL must be HTTPS.",
      );
    }
    if (!input.expectedIssuer) {
      fail(
        "authorization_server_metadata",
        "An expected issuer is required with a pinned authorization server metadata URL.",
      );
    }
    pinnedMetadata = { expectedIssuer: input.expectedIssuer, url };
  }
  const context = oauthHttpContext(input);
  const authorizationServer = (issuer: string | undefined) => {
    if (pinnedMetadata) {
      return fetchPinnedAuthorizationServer(
        context,
        pinnedMetadata.url,
        pinnedMetadata.expectedIssuer,
      );
    }
    if (!issuer) {
      fail(
        "authorization_server_metadata",
        "A pinned issuer is required when protected resource metadata is absent.",
      );
    }
    return fetchAuthorizationServer(context, issuer);
  };
  try {
    if (input.protectedResourceMetadata === "absent") {
      return {
        authorizationServer: await authorizationServer(input.pinnedIssuer),
        challenge: {},
      };
    }
    const challenge = await probeChallenge(context, mcpUrl);
    const protectedResource = await fetchProtectedResource(context, mcpUrl, challenge);
    const pinnedIssuer = input.pinnedIssuer;
    const issuer =
      (pinnedIssuer &&
        protectedResource.authorizationServers.find((entry) =>
          mcpIssuerIdentifiersEquivalent(entry, pinnedIssuer),
        )) ||
      protectedResource.authorizationServers[0]!;
    return {
      authorizationServer: await authorizationServer(issuer),
      challenge,
      protectedResource,
    };
  } catch (cause) {
    if (cause instanceof McpAuthorizationDiscoveryError) throw cause;
    throw new McpAuthorizationDiscoveryError(
      "network",
      context.signal.aborted
        ? "MCP authorization discovery timed out or was aborted."
        : `MCP authorization discovery request failed: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      { cause },
    );
  } finally {
    context.close();
  }
}
