import { PersistenceError, type Ulid } from "@deployments-ai/db";
import {
  McpAuthorizationDiscoveryError,
  type McpDiscoveredAuthorization,
} from "@deployments-ai/mcp-client";
import {
  VendorMcpConfigurationError,
  vendorMcpAuthorizationDrift,
  vendorMcpCanonicalUrl,
  vendorMcpDiscoveryInput,
  vendorMcpOAuthAppConfig,
  vendorMcpOAuthPins,
  vendorMcpResource,
  type PlatformOAuthAppConfig,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import { id, strings, text } from "./administration-persistence.ts";
import {
  VendorMcpAdministrationError,
  requireVendorMcpDependencies,
} from "./vendor-mcp-administration-errors.ts";
import { makeVendorMcpClientRegistration } from "./vendor-mcp-client-registration.ts";
import type { VendorMcpAdministrationDependencies } from "./vendor-mcp-dependencies.ts";

/** Everything authorization begin needs to build the URL and persist the attempt. */
export interface VendorMcpAuthorizationPlan {
  readonly config: PlatformOAuthAppConfig;
  /** RFC 8707 wire `resource` (pinned PRM resource, tenant-substituted). */
  readonly resource: string;
  readonly requestedScopes: readonly string[];
  readonly providerApplicationId?: Ulid;
  /** Attempt binding; `requestedResource` is the canonical MCP endpoint. */
  readonly attempt: {
    readonly oauthClientId: string;
    readonly oauthClientRegistration:
      | "pre_registered"
      | "client_id_metadata_document"
      | "dynamic_client_registration";
    readonly oauthIssParameterSupported: boolean;
    readonly oauthIssuer: string;
    readonly requestedResource: string;
  };
}

export function makeVendorMcpAuthorization(context: AdministrationPersistenceContext) {
  const { dependencies, assertScopes } = context;
  const { resolveVendorMcpClient } = makeVendorMcpClientRegistration(context);

  async function discover(
    definition: ProviderDefinition,
    canonicalUrl: string,
    discoverAuthorization: VendorMcpAdministrationDependencies["discoverAuthorization"],
  ): Promise<McpDiscoveredAuthorization> {
    try {
      return await discoverAuthorization(vendorMcpDiscoveryInput(definition, canonicalUrl));
    } catch (cause) {
      if (cause instanceof McpAuthorizationDiscoveryError && cause.code === "issuer_mismatch") {
        throw new VendorMcpAdministrationError(
          409,
          "mcp_authorization_server_mismatch",
          `${definition.displayName} authorization server drifted from the reviewed pins: ${cause.message}`,
          { cause },
        );
      }
      throw new VendorMcpAdministrationError(
        502,
        "mcp_discovery_failed",
        `${definition.displayName} MCP authorization discovery failed${
          cause instanceof McpAuthorizationDiscoveryError ? `: ${cause.message}` : "."
        }`,
        { cause },
      );
    }
  }

  /**
   * Vendor MCP begin: canonical endpoint, live discovery checked against pins, client
   * resolution in MCP registration priority, and the synthesized OAuth app protocol.
   */
  async function planVendorMcpAuthorization(
    invocation: AdministrationInvocation,
    definition: ProviderDefinition,
    body: Readonly<Record<string, unknown>>,
  ): Promise<VendorMcpAuthorizationPlan> {
    const ports = requireVendorMcpDependencies(dependencies);
    const { authorization } = vendorMcpOAuthPins(definition);
    let canonicalUrl: string;
    try {
      canonicalUrl = vendorMcpCanonicalUrl(
        definition,
        body.requestedResource === undefined
          ? undefined
          : text(body.requestedResource, "requestedResource"),
      );
    } catch (cause) {
      if (!(cause instanceof VendorMcpConfigurationError)) throw cause;
      throw new PersistenceError("unprocessable", "invalid_oauth_resource", cause.message);
    }
    const pinnedScopes = [...new Set(authorization.scopes)].toSorted();
    const requestedScopes =
      body.requestedScopes === undefined
        ? pinnedScopes
        : strings(body.requestedScopes, "requestedScopes");
    assertScopes(requestedScopes, pinnedScopes);
    const discovered = await discover(definition, canonicalUrl, ports.discoverAuthorization);
    const drift = vendorMcpAuthorizationDrift(definition, canonicalUrl, discovered);
    if (drift.length > 0) {
      throw new VendorMcpAdministrationError(
        409,
        "mcp_authorization_server_mismatch",
        `${definition.displayName} authorization server drifted from the reviewed pins: ${drift.join(" ")}`,
      );
    }
    const server = discovered.authorizationServer;
    const client = await resolveVendorMcpClient({
      definition,
      invocation,
      ports,
      server,
      ...(body.providerApplicationId === undefined
        ? {}
        : { providerApplicationId: id(text(body.providerApplicationId, "providerApplicationId")) }),
    });
    const config = vendorMcpOAuthAppConfig({
      canonicalUrl,
      clientAuthentication: client.clientAuthentication,
      clientId: client.clientId,
      definition,
      publicOrigin: ports.publicOrigin,
    });
    if (client.application && !client.application.data.redirectUris.includes(config.redirectUri)) {
      throw new PersistenceError(
        "unprocessable",
        "oauth_redirect_uri_mismatch",
        "OAuth application redirect URIs do not include the configured platform callback.",
      );
    }
    return {
      attempt: {
        oauthClientId: client.clientId,
        oauthClientRegistration: client.registration,
        oauthIssParameterSupported: server.authorizationResponseIssParameterSupported,
        oauthIssuer: server.issuer,
        requestedResource: canonicalUrl,
      },
      config,
      ...(client.application ? { providerApplicationId: client.application.data.id } : {}),
      requestedScopes,
      resource: vendorMcpResource(definition, canonicalUrl),
    };
  }

  return { planVendorMcpAuthorization };
}
