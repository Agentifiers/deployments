import { PersistenceError, type PlatformRecord } from "@deployments-ai/db";
import {
  OAUTH_REFRESH_REQUEST_KIND,
  oauthConnectionNeedsRefresh,
  vendorMcpCanonicalUrl,
  vendorMcpServer,
  VendorMcpConfigurationError,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import { vaultReference } from "./administration-persistence.ts";
import {
  VendorMcpAdministrationError,
  requireVendorMcpDependencies,
} from "./vendor-mcp-administration-errors.ts";

export type ProviderConnection = Extract<
  PlatformRecord,
  { readonly itemType: "provider-connection" }
>;

export interface VendorMcpConnectionCredential {
  /** Connection record the credential was read from (re-read after an on-demand refresh). */
  readonly connection: ProviderConnection;
  readonly credential: {
    readonly scopes?: readonly string[];
    readonly values: Readonly<Record<string, string>>;
  };
  readonly definition: ProviderDefinition;
  readonly endpointOrigin: string;
  readonly endpointPath: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Secret strings that must never appear in data returned by the vendor server. */
  readonly sensitiveMaterials: ReadonlySet<string>;
}

function headerValue(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    Array.from(trimmed).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new PersistenceError(
      "unprocessable",
      "invalid_credential",
      "The connection credential cannot be sent as an MCP request header.",
    );
  }
  return trimmed;
}

function reauthorizationRequired(): PersistenceError {
  return new PersistenceError(
    "conflict",
    "connection_reauthorization_required",
    "The connection must be re-authorized before it can reach its MCP server.",
  );
}

/**
 * Refresh an OAuth connection through the `oauth-refresh` Lambda when its access token is
 * within the refresh skew, returning the connection record whose credential should be read.
 */
async function refreshedConnection(
  context: AdministrationPersistenceContext,
  invocation: AdministrationInvocation,
  connection: ProviderConnection,
): Promise<ProviderConnection> {
  const { getRecord, now: currentTime } = context;
  const now = currentTime();
  const { refreshAfter } = connection.data;
  if (!oauthConnectionNeedsRefresh(refreshAfter ? { refreshAfter } : {}, now)) return connection;
  const reference = vaultReference(connection.data.credentialRef);
  const response = await requireVendorMcpDependencies(context.dependencies).refreshConnection({
    connectionId: connection.data.id,
    environmentId: connection.data.environmentId,
    expectedGeneration: reference.generation,
    kind: OAUTH_REFRESH_REQUEST_KIND,
    organizationId: connection.data.organizationId,
    projectId: connection.data.projectId,
    requestedBy: "api",
  });
  if (response.status === "retryable") {
    throw new VendorMcpAdministrationError(
      503,
      "connection_refresh_unavailable",
      "The connection credential could not be refreshed; retry the request.",
    );
  }
  if (response.status === "reauthorization_required") throw reauthorizationRequired();
  if (response.status === "not_refreshable") {
    // Without a refresh token the current access token stays usable until it expires.
    const expiresAt = Date.parse(connection.data.refreshAfter ?? "");
    if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) throw reauthorizationRequired();
    return connection;
  }
  const current = (await getRecord(
    invocation,
    "provider-connection",
    connection.data.id,
  )) as ProviderConnection;
  if (current.data.status !== "active" || !current.data.credentialRef) {
    throw reauthorizationRequired();
  }
  return current;
}

/**
 * Endpoint, request headers, and credential material for calling a vendor-hosted MCP
 * server with a provider connection's vaulted credential. OAuth access tokens are refreshed
 * on demand first. Secrets are only returned for outbound requests and leak checks.
 */
export async function readVendorMcpConnectionCredential(
  context: AdministrationPersistenceContext,
  invocation: AdministrationInvocation,
  connection: ProviderConnection,
): Promise<VendorMcpConnectionCredential> {
  const definition = context.providerDefinition(connection.data.providerKey);
  if (definition.route !== "vendor_mcp") {
    throw new PersistenceError(
      "unprocessable",
      "connection_not_vendor_mcp",
      "The connection does not belong to a vendor-hosted MCP provider.",
    );
  }
  requireVendorMcpDependencies(context.dependencies);
  if (!connection.data.credentialRef) {
    throw new PersistenceError(
      "unprocessable",
      "connection_not_verifiable",
      "Connection does not have an active credential.",
    );
  }
  const server = vendorMcpServer(definition);
  const oauth = server.authorization.kind === "oauth";
  const current = oauth ? await refreshedConnection(context, invocation, connection) : connection;
  const credential = await context.credentialValue(() =>
    context.dependencies.credentials.read({
      environmentId: current.data.environmentId,
      expectedIdentity: {
        ownerId: current.data.id,
        ownerType: "provider-connection",
        projectId: current.data.projectId,
        purpose: oauth ? "provider-oauth-token" : "provider-api",
      },
      organizationId: current.data.organizationId,
      reference: vaultReference(current.data.credentialRef),
    }),
  );
  const sensitiveMaterials = new Set<string>();
  let headers: Readonly<Record<string, string>>;
  if (server.authorization.kind === "oauth") {
    const accessToken = headerValue(credential.values.accessToken ?? "");
    const authorization = `Bearer ${accessToken}`;
    headers = { authorization };
    sensitiveMaterials.add(accessToken).add(authorization);
    const refreshToken = credential.values.refreshToken?.trim();
    if (refreshToken) sensitiveMaterials.add(refreshToken);
  } else {
    const key = headerValue(credential.values[server.authorization.field] ?? "");
    const value = server.authorization.scheme ? `${server.authorization.scheme} ${key}` : key;
    headers = { [server.authorization.headerName]: value };
    sensitiveMaterials.add(key).add(value);
    for (const field of definition.auth.fields) {
      const secret = field.sensitive ? credential.values[field.key]?.trim() : undefined;
      if (secret) sensitiveMaterials.add(secret);
    }
  }
  let canonicalUrl: string;
  try {
    canonicalUrl = current.data.oauthResource ?? vendorMcpCanonicalUrl(definition);
  } catch (cause) {
    if (!(cause instanceof VendorMcpConfigurationError)) throw cause;
    throw new PersistenceError("unprocessable", "invalid_oauth_resource", cause.message);
  }
  const endpoint = new URL(canonicalUrl);
  return {
    connection: current,
    credential,
    definition,
    endpointOrigin: endpoint.origin,
    endpointPath: `${endpoint.pathname}${endpoint.search}`,
    headers,
    sensitiveMaterials,
  };
}
