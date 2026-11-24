import {
  PersistenceError,
  ProviderApplicationRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import type { DynamicOAuthClientRegistration } from "@deployments-ai/mcp-client";
import {
  vendorMcpClientMetadataUrl,
  vendorMcpIssuerEquivalent,
  vendorMcpIsTemplated,
  vendorMcpOAuthPins,
  type ProviderDefinition,
  type VendorMcpDiscoveredAuthorization,
  type VendorMcpOAuthAuthorization,
  type VendorMcpTokenEndpointAuthMethod,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import type {
  AdministrationPersistenceContext,
  EnvironmentRecord,
} from "./administration-persistence.ts";
import { recordOperations } from "./administration-persistence.ts";
import { VendorMcpAdministrationError } from "./vendor-mcp-administration-errors.ts";
import type { VendorMcpAdministrationDependencies } from "./vendor-mcp-dependencies.ts";

type ProviderApplication = Extract<
  EnvironmentRecord,
  { readonly itemType: "provider-application" }
>;
type AuthorizationServer = VendorMcpDiscoveredAuthorization["authorizationServer"];

const CALLBACK_PATH_PREFIX = "/public/provider-connections/oauth/callback/";
const CLIENT_NAME = "Deployments.ai";
const CLIENT_URI = "https://deployments.ai";

/** OAuth client a vendor MCP authorization runs with, in MCP registration priority order. */
export interface VendorMcpClient {
  readonly clientId: string;
  readonly clientAuthentication: VendorMcpTokenEndpointAuthMethod;
  readonly registration:
    | "pre_registered"
    | "client_id_metadata_document"
    | "dynamic_client_registration";
  /** Absent for client ID metadata documents. */
  readonly application?: ProviderApplication;
}

/** `${publicOrigin}/public/provider-connections/oauth/callback/${oauthProviderKey}`. */
export function vendorMcpCallbackUri(publicOrigin: string, definition: ProviderDefinition): string {
  // The CIMD URL helper validates the exact channel API origin.
  const origin = new URL(vendorMcpClientMetadataUrl(publicOrigin)).origin;
  return `${origin}${CALLBACK_PATH_PREFIX}${definition.oauthProviderKey ?? definition.key}`;
}

/** Secret-bearing pinned method for confidential clients, else `none`. */
function confidentialMethod(
  authorization: VendorMcpOAuthAuthorization,
): VendorMcpTokenEndpointAuthMethod {
  return authorization.tokenEndpointAuthMethods.find((method) => method !== "none") ?? "none";
}

/**
 * Persisted registration for an operator-registered (`oauth-app register`) vendor client.
 * `requested` may only be `{ method: "pre_registered", tokenEndpointAuthMethod? }` with a
 * pinned method; the default is the first pinned secret-bearing method, else `none`.
 */
export function vendorMcpPreRegistration(
  definition: ProviderDefinition,
  timestamp: string,
  requested?: unknown,
): {
  readonly issuer?: string;
  readonly method: "pre_registered";
  readonly registeredAt: string;
  readonly tokenEndpointAuthMethod: VendorMcpTokenEndpointAuthMethod;
} {
  const { authorization } = vendorMcpOAuthPins(definition);
  if (!authorization.registrationMethods.includes("pre_registered")) {
    throw new PersistenceError(
      "unprocessable",
      "registration_method_unsupported",
      `${definition.displayName} does not accept pre-registered OAuth clients.`,
    );
  }
  let tokenEndpointAuthMethod = confidentialMethod(authorization);
  if (requested !== undefined) {
    const body =
      requested && typeof requested === "object" && !Array.isArray(requested)
        ? (requested as Readonly<Record<string, unknown>>)
        : {};
    const method = authorization.tokenEndpointAuthMethods.find(
      (candidate) => candidate === (body.tokenEndpointAuthMethod ?? tokenEndpointAuthMethod),
    );
    if (body.method !== "pre_registered" || method === undefined) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_registration",
        `Registration must be pre_registered with one of ${authorization.tokenEndpointAuthMethods.join(", ")}.`,
      );
    }
    tokenEndpointAuthMethod = method;
  }
  return {
    // Templated issuers differ per tenant; such applications are not bound to one issuer.
    ...(vendorMcpIsTemplated(authorization.issuer) ? {} : { issuer: authorization.issuer }),
    method: "pre_registered",
    registeredAt: timestamp,
    tokenEndpointAuthMethod,
  };
}

function applicationIsPreRegistered(application: ProviderApplication) {
  return application.data.registration?.method === "pre_registered";
}

function applicationMismatch(message: string) {
  return new PersistenceError("conflict", "provider_application_mismatch", message);
}

function issuerBound(application: ProviderApplication, issuer: string) {
  const bound = application.data.registration?.issuer;
  return bound === undefined || vendorMcpIssuerEquivalent(bound, issuer);
}

export function makeVendorMcpClientRegistration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    credentialValue,
    environment,
    getRecord,
    listAllRecordsConsistently,
    write,
  } = context;

  function applicationClient(
    definition: ProviderDefinition,
    application: ProviderApplication,
  ): VendorMcpClient {
    // Mirrors the channel runtime's `vendorApplicationAuthentication`; keep both identical.
    const { authorization } = vendorMcpOAuthPins(definition);
    const { registration } = application.data;
    if (!registration) {
      throw applicationMismatch(
        "OAuth application has no vendor MCP registration; register it with a token endpoint authentication method.",
      );
    }
    const clientAuthentication = registration.tokenEndpointAuthMethod;
    if (!authorization.tokenEndpointAuthMethods.includes(clientAuthentication)) {
      throw applicationMismatch(
        `OAuth application token endpoint authentication ${clientAuthentication} is not supported by ${definition.displayName}.`,
      );
    }
    if ((clientAuthentication !== "none") !== (application.data.clientSecretRef !== undefined)) {
      throw applicationMismatch(
        clientAuthentication === "none"
          ? "OAuth application holds a client secret but authenticates as a public client."
          : "OAuth application has no active client secret.",
      );
    }
    return {
      application,
      clientAuthentication,
      clientId: application.data.clientId,
      registration: registration.method,
    };
  }

  async function activeApplications(
    invocation: AdministrationInvocation,
    definition: ProviderDefinition,
    issuer: string,
  ) {
    const records = await listAllRecordsConsistently(
      invocation,
      "provider-application",
      (record) =>
        record.itemType === "provider-application" &&
        record.data.providerKey === definition.key &&
        record.data.status === "active",
    );
    // Registration-less applications are never selected automatically, so CIMD and DCR apply.
    return (records as ProviderApplication[]).filter(
      (record) => record.data.registration !== undefined && issuerBound(record, issuer),
    );
  }

  async function explicitApplication(
    invocation: AdministrationInvocation,
    definition: ProviderDefinition,
    issuer: string,
    providerApplicationId: Ulid,
  ) {
    const application = (await getRecord(
      invocation,
      "provider-application",
      providerApplicationId,
    )) as ProviderApplication;
    if (
      application.data.providerKey !== definition.key ||
      application.data.status !== "active" ||
      !issuerBound(application, issuer)
    ) {
      throw applicationMismatch(
        "OAuth application does not match the requested provider and authorization server.",
      );
    }
    return application;
  }

  async function register(
    invocation: AdministrationInvocation,
    definition: ProviderDefinition,
    server: AuthorizationServer & { readonly registrationEndpoint: string },
    ports: VendorMcpAdministrationDependencies,
  ): Promise<VendorMcpClient> {
    const { authorization } = vendorMcpOAuthPins(definition);
    const scope = await environment(invocation);
    const redirectUri = vendorMcpCallbackUri(ports.publicOrigin, definition);
    const requestedMethod: VendorMcpTokenEndpointAuthMethod =
      authorization.tokenEndpointAuthMethods.includes("none")
        ? "none"
        : authorization.tokenEndpointAuthMethods.includes("client_secret_post")
          ? "client_secret_post"
          : "client_secret_basic";
    let registered: DynamicOAuthClientRegistration;
    try {
      registered = await ports.registerClient({
        metadata: {
          application_type: "web",
          client_name: CLIENT_NAME,
          client_uri: CLIENT_URI,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: requestedMethod,
        },
        registrationEndpoint: server.registrationEndpoint,
      });
    } catch (cause) {
      throw new VendorMcpAdministrationError(
        502,
        "mcp_client_registration_failed",
        `${definition.displayName} rejected dynamic OAuth client registration.`,
        { cause },
      );
    }
    const tokenEndpointAuthMethod = authorization.tokenEndpointAuthMethods.find(
      (method) => method === registered.tokenEndpointAuthMethod,
    );
    if (
      tokenEndpointAuthMethod === undefined ||
      (tokenEndpointAuthMethod !== "none" && !registered.clientSecret)
    ) {
      throw new VendorMcpAdministrationError(
        502,
        "mcp_client_registration_failed",
        `${definition.displayName} registered a client with unsupported token endpoint authentication.`,
      );
    }
    const timestamp = now().toISOString();
    const applicationId = (await generateId()) as Ulid;
    const clientSecret = tokenEndpointAuthMethod === "none" ? undefined : registered.clientSecret;
    const preparedSecret = clientSecret
      ? await credentialValue(async () =>
          dependencies.credentials.prepareWrite({
            identity: {
              credentialId: (await generateId()) as Ulid,
              environmentId: scope.id,
              organizationId: scope.organizationId,
              ownerId: applicationId,
              ownerType: "provider-application",
              projectId: scope.projectId,
              purpose: "provider-oauth-client-secret",
            },
            secret: { values: { clientSecret } },
          }),
        )
      : undefined;
    const application = Schema.decodeUnknownSync(ProviderApplicationRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-application",
        data: {
          clientId: registered.clientId,
          ...(preparedSecret ? { clientSecretRef: preparedSecret.reference } : {}),
          createdAt: timestamp,
          displayName: `${definition.displayName} (dynamic registration)`,
          environmentId: scope.id,
          id: applicationId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          providerKey: definition.key,
          redirectUris: [redirectUri],
          registration: {
            issuer: server.issuer,
            method: "dynamic_client_registration",
            registeredAt: timestamp,
            tokenEndpointAuthMethod,
          },
          requestedScopes: [...new Set(authorization.scopes)].toSorted(),
          status: "active",
          updatedAt: timestamp,
          version: 0,
        },
      }),
    ) as ProviderApplication;
    try {
      await write(
        invocation,
        [
          ...(preparedSecret ? [preparedSecret.operation] : []),
          ...recordOperations(application, timestamp),
        ],
        "provider-application.register",
      );
    } catch (cause) {
      if (!(cause instanceof PersistenceError) || cause.kind !== "conflict") throw cause;
      // A concurrent begin won the issuer-bound registration claim; use its client.
      const winner = (await activeApplications(invocation, definition, server.issuer)).find(
        (record) => record.data.registration?.method === "dynamic_client_registration",
      );
      if (!winner) throw cause;
      return applicationClient(definition, winner);
    }
    return applicationClient(definition, application);
  }

  /**
   * MCP registration priority: an active issuer-bound provider-application (pre-registered
   * before dynamic), then a client ID metadata document, then dynamic client registration.
   */
  async function resolveVendorMcpClient(input: {
    readonly invocation: AdministrationInvocation;
    readonly definition: ProviderDefinition;
    readonly server: AuthorizationServer;
    readonly ports: VendorMcpAdministrationDependencies;
    readonly providerApplicationId?: Ulid;
  }): Promise<VendorMcpClient> {
    const { definition, invocation, ports, server } = input;
    if (input.providerApplicationId !== undefined) {
      return applicationClient(
        definition,
        await explicitApplication(
          invocation,
          definition,
          server.issuer,
          input.providerApplicationId,
        ),
      );
    }
    const applications = await activeApplications(invocation, definition, server.issuer);
    const preRegistered = applications.filter(applicationIsPreRegistered);
    if (preRegistered.length > 1) {
      throw new PersistenceError(
        "unprocessable",
        "provider_application_required",
        "Specify the active OAuth application to use.",
      );
    }
    const application =
      preRegistered[0] ?? applications.find((record) => !applicationIsPreRegistered(record));
    if (application) return applicationClient(definition, application);
    const { authorization, server: pins } = vendorMcpOAuthPins(definition);
    if (
      authorization.registrationMethods.includes("client_id_metadata_document") &&
      authorization.tokenEndpointAuthMethods.includes("none") &&
      server.clientIdMetadataDocumentSupported
    ) {
      return {
        clientAuthentication: "none",
        clientId: vendorMcpClientMetadataUrl(ports.publicOrigin),
        registration: "client_id_metadata_document",
      };
    }
    if (
      authorization.registrationMethods.includes("dynamic_client_registration") &&
      server.registrationEndpoint !== undefined
    ) {
      return register(
        invocation,
        definition,
        { ...server, registrationEndpoint: server.registrationEndpoint },
        ports,
      );
    }
    throw new PersistenceError(
      "conflict",
      "provider_application_required",
      `${definition.displayName} requires a pre-registered OAuth client; register one with \`deployments oauth-app register\` (see ${pins.documentationUrl}).`,
    );
  }

  return { resolveVendorMcpClient };
}
