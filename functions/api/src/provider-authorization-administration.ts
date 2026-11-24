import {
  OAuthAuthorizationAttemptRecord,
  PersistenceError,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  normalizeImmutableHttpsOrigin,
  platformOAuthAuthorizationUrl,
  platformOAuthReturnTo,
  platformOAuthStateHash,
  type PlatformOAuthAppConfig,
  type ProviderDefinition,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import { randomBytes } from "node:crypto";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import { asObject, id, recordOperations, strings, text } from "./administration-persistence.ts";
import { makeVendorMcpAuthorization } from "./vendor-mcp-authorization-begin.ts";

/** Route-specific inputs to the shared state, PKCE, and attempt persistence. */
interface AuthorizationPlan {
  readonly config: PlatformOAuthAppConfig;
  /** RFC 8707 resource sent on the authorization request. */
  readonly resource?: string;
  readonly requestedScopes: readonly string[];
  readonly providerApplicationId?: Ulid;
  readonly attempt: {
    readonly oauthClientId?: string;
    readonly oauthClientRegistration?:
      | "pre_registered"
      | "client_id_metadata_document"
      | "dynamic_client_registration";
    readonly oauthIssParameterSupported?: boolean;
    readonly oauthIssuer?: string;
    readonly requestedResource?: string;
  };
}

export function makeProviderAuthorizationAdministration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    credentialValue,
    environment,
    getRecord,
    listAllRecordsConsistently,
    providerDefinition,
    assertScopes,
    write,
  } = context;
  const { planVendorMcpAuthorization } = makeVendorMcpAuthorization(context);

  async function planPlatformOAuthAuthorization(
    invocation: AdministrationInvocation,
    definition: ProviderDefinition,
    body: Readonly<Record<string, unknown>>,
  ): Promise<AuthorizationPlan> {
    let application: Extract<PlatformRecord, { readonly itemType: "provider-application" }>;
    if (body.providerApplicationId) {
      application = (await getRecord(
        invocation,
        "provider-application",
        id(text(body.providerApplicationId, "providerApplicationId")),
      )) as typeof application;
    } else {
      const applications = await listAllRecordsConsistently(
        invocation,
        "provider-application",
        (record) =>
          record.itemType === "provider-application" &&
          record.data.providerKey === definition.key &&
          record.data.status === "active",
      );
      if (applications.length !== 1) {
        throw new PersistenceError(
          "unprocessable",
          "provider_application_required",
          "Specify the active OAuth application to use.",
        );
      }
      application = applications[0] as typeof application;
    }
    if (application.data.providerKey !== definition.key || application.data.status !== "active") {
      throw new PersistenceError(
        "unprocessable",
        "provider_application_mismatch",
        "OAuth application does not match the requested provider.",
      );
    }
    const requestedScopes =
      body.requestedScopes === undefined
        ? application.data.requestedScopes
        : strings(body.requestedScopes, "requestedScopes");
    assertScopes(requestedScopes, application.data.requestedScopes);
    const rawRequestedResource =
      body.requestedResource === undefined
        ? undefined
        : text(body.requestedResource, "requestedResource");
    const oauthKey = definition.oauthProviderKey ?? definition.key;
    const base = dependencies.oauthApplications?.[oauthKey];
    if (!base) {
      throw new PersistenceError(
        "unprocessable",
        "oauth_provider_unconfigured",
        "OAuth provider configuration is unavailable.",
      );
    }
    let requestedResource: string | undefined;
    if (rawRequestedResource !== undefined) {
      if (base.tokenAuthorizedAccountIdsPath) {
        requestedResource = rawRequestedResource;
      } else {
        try {
          requestedResource = normalizeImmutableHttpsOrigin(
            rawRequestedResource,
            "Requested OAuth resource",
          );
        } catch {
          throw new PersistenceError(
            "unprocessable",
            "invalid_oauth_resource",
            "Requested OAuth resource is not supported by the provider.",
          );
        }
        if (!definition.oauthResources.includes(requestedResource)) {
          throw new PersistenceError(
            "unprocessable",
            "invalid_oauth_resource",
            "Requested OAuth resource is not supported by the provider.",
          );
        }
      }
    }
    if (!application.data.redirectUris.includes(base.redirectUri)) {
      throw new PersistenceError(
        "unprocessable",
        "oauth_redirect_uri_mismatch",
        "OAuth application redirect URIs do not include the configured platform callback.",
      );
    }
    if (!application.data.clientSecretRef) {
      throw new PersistenceError(
        "unprocessable",
        "oauth_application_secret_required",
        "OAuth application has no active client secret.",
      );
    }
    const config = {
      ...base,
      clientId: application.data.clientId,
    } satisfies PlatformOAuthAppConfig;
    return {
      attempt: requestedResource ? { requestedResource } : {},
      config,
      providerApplicationId: application.data.id,
      requestedScopes,
      ...(requestedResource && !config.tokenAuthorizedAccountIdsPath
        ? { resource: requestedResource }
        : {}),
    };
  }

  async function beginProviderAuthorization(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const definition = providerDefinition(body.providerKey);
    if (definition.auth.kind !== "oauth") {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "Provider does not support OAuth authorization.",
      );
    }
    let returnTo: string | undefined;
    if (body.returnTo !== undefined) {
      try {
        // A non-string `returnTo` fails validation like any other disallowed value.
        returnTo = platformOAuthReturnTo(
          typeof body.returnTo === "string" ? body.returnTo : "",
          dependencies.oauthReturnOrigins ?? [],
        );
      } catch {
        throw new PersistenceError(
          "unprocessable",
          "invalid_return_to",
          "returnTo must be an https URL on an allowed return origin.",
        );
      }
    }
    const plan: AuthorizationPlan =
      definition.route === "vendor_mcp"
        ? await planVendorMcpAuthorization(invocation, definition, body)
        : await planPlatformOAuthAuthorization(invocation, definition, body);
    const attemptId = id(await generateId());
    const verifier = randomBytes(32).toString("base64url");
    const state = [
      scope.organizationId,
      scope.projectId,
      scope.id,
      attemptId,
      randomBytes(32).toString("base64url"),
    ].join(".");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1_000).toISOString();
    const preparedPkce = await credentialValue(async () =>
      dependencies.credentials.prepareWrite({
        identity: {
          credentialId: id(await generateId()),
          environmentId: scope.id,
          organizationId: scope.organizationId,
          ownerId: attemptId,
          ownerType: "oauth-authorization-attempt",
          projectId: scope.projectId,
          purpose: "oauth-pkce-verifier",
        },
        secret: {
          expiresAt,
          values: { verifier },
        },
      }),
    );
    const attempt = Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
      withCanonicalRecordKeys({
        itemType: "oauth-authorization-attempt",
        data: {
          ...plan.attempt,
          createdAt: createdAt.toISOString(),
          environmentId: scope.id,
          expiresAt,
          id: attemptId,
          organizationId: scope.organizationId,
          principalId: id(text(invocation.identity?.principalId, "principalId")),
          projectId: scope.projectId,
          pkceSecretRef: preparedPkce.reference,
          ...(plan.providerApplicationId
            ? { providerApplicationId: plan.providerApplicationId }
            : {}),
          providerKey: definition.key,
          requestedScopes: plan.requestedScopes,
          ...(returnTo ? { returnTo } : {}),
          stateHash: platformOAuthStateHash(state),
          status: "pending",
          version: 0,
        },
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    );
    const authorizationUrl = platformOAuthAuthorizationUrl({
      app: plan.config,
      ...(plan.resource ? { resource: plan.resource } : {}),
      scopes: plan.requestedScopes,
      state,
      verifier,
    });
    await write(
      invocation,
      [preparedPkce.operation, ...recordOperations(attempt, attempt.data.createdAt)],
      "provider-authorization.begin",
    );
    return {
      authorizationUrl,
      expiresAt,
    };
  }
  return { beginProviderAuthorization };
}
