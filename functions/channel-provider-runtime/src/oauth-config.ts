import { ProviderApplicationRecord, type Ulid } from "@deployments-ai/db";
import {
  vendorMcpCanonicalUrl,
  vendorMcpClientMetadataUrl,
  vendorMcpOAuthAppConfig,
  vendorMcpOAuthPins,
  vendorMcpResource,
  type PlatformOAuthAppConfig,
  type ProviderDefinition,
  type VendorMcpTokenEndpointAuthMethod,
} from "@deployments-ai/providers";
import { Schema } from "effect";

import type { OAuthRuntimeDependencies, OAuthScope } from "./oauth-runtime-dependencies.ts";
import { appConfig } from "./oauth-validation.ts";
import { required } from "./required-value.ts";
import { vaultReference } from "./runtime.ts";

type OAuthClientRegistration =
  | "client_id_metadata_document"
  | "dynamic_client_registration"
  | "pre_registered";

type ProviderApplication = typeof ProviderApplicationRecord.Type;

/** OAuth client and resource binding recorded on an authorization attempt or connection. */
export interface OAuthConfigSubject {
  readonly oauthClientId?: string;
  readonly oauthClientRegistration?: OAuthClientRegistration;
  /** Canonical MCP endpoint (`attempt.requestedResource` / `connection.oauthResource`). */
  readonly oauthResource?: string;
  readonly providerApplicationId?: string;
  readonly providerKey: string;
}

export type ResolvedOAuthAppConfig =
  | {
      readonly application: ProviderApplication;
      readonly config: PlatformOAuthAppConfig;
      readonly route: "platform_oauth";
    }
  | {
      readonly application?: ProviderApplication;
      /** Canonical MCP endpoint stored on the connection and its credential material. */
      readonly canonicalUrl: string;
      readonly config: PlatformOAuthAppConfig;
      readonly definition: ProviderDefinition;
      /** RFC 8707 `resource` sent on token and refresh requests. */
      readonly resource: string;
      readonly route: "vendor_mcp";
    };

async function applicationClientSecret(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  application: ProviderApplication,
) {
  if (!application.data.clientSecretRef) {
    throw new Error("Provider application has no client secret.");
  }
  const vault = await dependencies.vault(scope);
  const secret = await vault.read({
    environmentId: scope.environmentId as Ulid,
    expectedIdentity: {
      ownerId: application.data.id,
      ownerType: "provider-application",
      projectId: application.data.projectId,
      purpose: "provider-oauth-client-secret",
    },
    organizationId: scope.organizationId as Ulid,
    reference: vaultReference(application.data.clientSecretRef),
  });
  return secret.values;
}

async function loadApplication(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  applicationId: string,
) {
  return Schema.decodeUnknownSync(ProviderApplicationRecord)(
    await dependencies.loadControlRecord(scope, "provider-application", applicationId),
  );
}

/**
 * Token endpoint client authentication of a pre-registered or dynamically registered vendor
 * MCP application: its recorded registration method, which must be pinned by the server and
 * agree with the application's secret presence. Mirrors the administration API's
 * `applicationClient` (`provider_application_mismatch`); keep both identical.
 */
function vendorApplicationAuthentication(
  definition: ProviderDefinition,
  application: ProviderApplication,
): VendorMcpTokenEndpointAuthMethod {
  const method = application.data.registration?.tokenEndpointAuthMethod;
  if (
    method === undefined ||
    !vendorMcpOAuthPins(definition).authorization.tokenEndpointAuthMethods.includes(method) ||
    (method !== "none") !== (application.data.clientSecretRef !== undefined)
  ) {
    throw new Error("Vendor MCP provider application does not match the OAuth client.");
  }
  return method;
}

async function vendorMcpConfig(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  definition: ProviderDefinition,
  subject: OAuthConfigSubject,
): Promise<ResolvedOAuthAppConfig> {
  const publicOrigin = dependencies.publicOrigin();
  if (!publicOrigin) throw new Error("Vendor MCP OAuth requires PLATFORM_OAUTH_PUBLIC_ORIGIN.");
  const canonicalUrl = vendorMcpCanonicalUrl(
    definition,
    required(subject.oauthResource, "Vendor MCP OAuth resource"),
  );
  const clientId = required(subject.oauthClientId, "Vendor MCP OAuth client id");
  const registration = subject.oauthClientRegistration;
  if (!registration) throw new Error("Vendor MCP OAuth client registration is required.");
  const base = { canonicalUrl, clientId, definition, publicOrigin };
  const resource = vendorMcpResource(definition, canonicalUrl);
  if (registration === "client_id_metadata_document") {
    if (clientId !== vendorMcpClientMetadataUrl(publicOrigin)) {
      throw new Error("Vendor MCP OAuth client id is not this environment's metadata document.");
    }
    return {
      canonicalUrl,
      config: vendorMcpOAuthAppConfig({ ...base, clientAuthentication: "none" }),
      definition,
      resource,
      route: "vendor_mcp",
    };
  }
  const application = await loadApplication(
    dependencies,
    scope,
    required(subject.providerApplicationId, "Vendor MCP provider application"),
  );
  if (
    application.data.providerKey !== definition.key ||
    application.data.clientId !== clientId ||
    application.data.registration?.method !== registration
  ) {
    throw new Error("Vendor MCP provider application does not match the OAuth client.");
  }
  const clientAuthentication = vendorApplicationAuthentication(definition, application);
  const config = vendorMcpOAuthAppConfig({ ...base, clientAuthentication });
  return {
    application,
    canonicalUrl,
    config:
      clientAuthentication === "none"
        ? config
        : {
            ...config,
            clientSecret: required(
              (await applicationClientSecret(dependencies, scope, application)).clientSecret,
              "clientSecret",
            ),
          },
    definition,
    resource,
    route: "vendor_mcp",
  };
}

/**
 * The single OAuth app configuration seam for callback, refresh, revoke, and internal
 * refresh: the OpenTofu registry for `platform_oauth`, or protocol synthesized from the
 * code-owned `mcpServer` pins and the recorded client registration for `vendor_mcp`.
 */
export async function resolveOAuthAppConfig(
  dependencies: OAuthRuntimeDependencies,
  scope: OAuthScope,
  subject: OAuthConfigSubject,
): Promise<ResolvedOAuthAppConfig> {
  const definitions = dependencies.definitions();
  const definition = definitions.resolve(subject.providerKey);
  if (definition?.route === "vendor_mcp") {
    return vendorMcpConfig(dependencies, scope, definition, subject);
  }
  const application = await loadApplication(
    dependencies,
    scope,
    required(subject.providerApplicationId, "OAuth provider application"),
  );
  const credentials = await applicationClientSecret(dependencies, scope, application);
  return {
    application,
    config: appConfig(application, credentials, definitions, dependencies.platformApps()),
    route: "platform_oauth",
  };
}
