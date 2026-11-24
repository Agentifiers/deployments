import {
  Keys,
  Ulid,
  authorizePlatformHumanScope,
  key,
  organizationRoleAllows,
  organizationRolesAllowing,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  createPlatformJwtVerifier,
  isJwtBearerToken,
  platformJwtClaims,
  resolvePlatformJwtClaimProfile,
  type JwtAuthenticationOptions,
} from "@deployments-ai/identity/platform-jwt";
import { Schema } from "effect";
import { RuntimeApiError } from "./runtime-api-error.ts";
import { credentialHash, exactHash } from "./runtime-auth-crypto.ts";
import type {
  RuntimeApiCredentialPrincipal,
  RuntimeApiPrincipal,
  RuntimeApiScope,
  RuntimeHumanAuthenticator,
  RuntimeHumanPrincipal,
} from "./runtime-principal.ts";
import { assertRecord, getRecord, headers, id, type HttpApiEvent } from "./runtime-support.ts";

const TENANT_HEADERS = {
  environmentId: "x-deployments-environment",
  organizationId: "x-deployments-organization",
  projectId: "x-deployments-project",
} as const;

const decodeUlid = Schema.decodeUnknownSync(Ulid);

async function authenticateRuntimeApiCredential(
  token: string,
  database: DynamoDatabaseService,
  now = new Date(),
): Promise<RuntimeApiCredentialPrincipal> {
  const hash = credentialHash(token);
  const claim = await getRecord(
    database,
    "control",
    Keys.control.uniqueClaim("api-credential-hash", hash),
  );
  if (
    !claim ||
    claim.itemType !== "unique-claim" ||
    claim.data.ownerItemType !== "api-credential"
  ) {
    throw new RuntimeApiError(401, "unauthorized", "The API key is invalid.");
  }
  const credential = assertRecord(
    await getRecord(database, "control", { pk: claim.data.ownerPk, sk: claim.data.ownerSk }),
    "api-credential",
    "API credential",
  );
  if (
    credential.data.status !== "active" ||
    credential.data.revokedAt !== undefined ||
    (credential.data.expiresAt !== undefined &&
      Date.parse(credential.data.expiresAt) <= now.getTime()) ||
    !exactHash(credential.data.credentialHash, hash)
  ) {
    throw new RuntimeApiError(401, "unauthorized", "The API key is inactive or expired.");
  }
  const scope = {
    environmentId: credential.data.environmentId,
    organizationId: credential.data.organizationId,
    projectId: credential.data.projectId,
  };
  const serviceAccount = assertRecord(
    await getRecord(database, "control", {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key("SERVICE-ACCOUNT", credential.data.serviceAccountId),
    }),
    "service-account",
    "Service account",
  );
  if (
    serviceAccount.data.status !== "active" ||
    serviceAccount.data.organizationId !== scope.organizationId ||
    serviceAccount.data.projectId !== scope.projectId ||
    serviceAccount.data.environmentId !== scope.environmentId
  ) {
    throw new RuntimeApiError(
      401,
      "unauthorized",
      "The service account is inactive or out of scope.",
    );
  }
  return { credential, kind: "api-credential", scope, serviceAccount };
}

/** Human callers must name their environment; API keys are bound to one already. */
function requestedTenantScope(
  requestHeaders: Readonly<Record<string, string | undefined>>,
): RuntimeApiScope {
  const values = Object.fromEntries(
    Object.entries(TENANT_HEADERS).map(([field, name]) => [field, requestHeaders[name]?.trim()]),
  ) as Record<keyof RuntimeApiScope, string | undefined>;
  if (!values.organizationId || !values.projectId || !values.environmentId) {
    throw new RuntimeApiError(
      403,
      "tenant_scope_required",
      "Platform bearer tokens require x-deployments-organization, x-deployments-project, and x-deployments-environment.",
    );
  }
  return {
    environmentId: id(values.environmentId, TENANT_HEADERS.environmentId),
    organizationId: id(values.organizationId, TENANT_HEADERS.organizationId),
    projectId: id(values.projectId, TENANT_HEADERS.projectId),
  };
}

export interface RuntimeHumanAuthenticatorOptions {
  readonly database: DynamoDatabaseService;
  readonly jwt: JwtAuthenticationOptions;
}

/**
 * Accepts the same platform bearer JWTs as the control plane (issuer, audience, and key set),
 * then admits the holder to the requested environment only through live control-table state:
 * an active human principal and an active organization membership, or the platform
 * administrator role.
 */
export function createRuntimeHumanAuthenticator(
  options: RuntimeHumanAuthenticatorOptions,
): RuntimeHumanAuthenticator {
  const verify = createPlatformJwtVerifier(options.jwt);
  const claimProfile = resolvePlatformJwtClaimProfile(options.jwt);
  return async (token, requestHeaders) => {
    const claims = await verify(token).then(
      (payload) => platformJwtClaims(payload, claimProfile),
      () => null,
    );
    if (!claims) {
      throw new RuntimeApiError(
        401,
        "unauthorized",
        "The platform bearer token is invalid or expired.",
      );
    }
    const scope = requestedTenantScope(requestHeaders);
    if (
      (claims.organizationId !== undefined && claims.organizationId !== scope.organizationId) ||
      (claims.projectId !== undefined && claims.projectId !== scope.projectId) ||
      (claims.environmentId !== undefined && claims.environmentId !== scope.environmentId)
    ) {
      throw new RuntimeApiError(
        403,
        "environment_scope_violation",
        "The tenant headers are outside the bearer token's tenant claims.",
      );
    }
    const principalId = decodeUlid(claims.principalId);
    const access = await authorizePlatformHumanScope(options.database, {
      ...scope,
      principalId,
      ...(claims.tokenSessionId ? { tokenSessionId: decodeUlid(claims.tokenSessionId) } : {}),
    });
    switch (access.kind) {
      case "denied":
        throw new RuntimeApiError(
          403,
          "organization_scope_violation",
          "The caller cannot access the requested environment.",
        );
      case "sso-required":
        throw new RuntimeApiError(
          403,
          "organization_sso_required",
          "The organization requires single sign-on.",
        );
      case "operator-access-required":
        throw new RuntimeApiError(
          403,
          "operator_access_required",
          "Platform administrators need open operator access to this organization. Open access from the system organization page or with `deployments system access-open`, then retry.",
        );
      case "member":
      case "platform-administrator":
        return {
          kind: "human",
          ...(access.kind === "member"
            ? { organizationRole: access.role }
            : { operatorAccessGrantId: access.operatorAccess.grantId }),
          platformAdministrator: access.kind === "platform-administrator",
          principalId,
          scope,
          scopes: claims.scopes,
        };
    }
  };
}

export async function authenticateRuntimeApi(
  event: HttpApiEvent,
  dependencies: {
    readonly authenticateHuman?: RuntimeHumanAuthenticator;
    readonly database: DynamoDatabaseService;
    readonly now?: () => Date;
  },
): Promise<RuntimeApiPrincipal> {
  const requestHeaders = headers(event);
  const token = requestHeaders.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  if (!token) {
    throw new RuntimeApiError(
      401,
      "unauthorized",
      "A bearer API key or platform bearer token is required.",
    );
  }
  if (isJwtBearerToken(token)) {
    if (!dependencies.authenticateHuman) {
      throw new RuntimeApiError(
        401,
        "unauthorized",
        "Platform bearer tokens are not accepted by this runtime API.",
      );
    }
    return dependencies.authenticateHuman(token, requestHeaders);
  }
  return authenticateRuntimeApiCredential(
    token,
    dependencies.database,
    dependencies.now?.() ?? new Date(),
  );
}

/** Tenant headers an API key sends are advisory and must name the key's own environment. */
export function assertScopeHeaders(event: HttpApiEvent, principal: RuntimeApiPrincipal) {
  const values = headers(event);
  for (const [field, name] of Object.entries(TENANT_HEADERS)) {
    const expected = principal.scope[field as keyof RuntimeApiScope];
    if (values[name] !== undefined && values[name] !== expected) {
      throw new RuntimeApiError(
        403,
        "environment_scope_violation",
        `${name} does not match the API credential.`,
      );
    }
  }
}

/**
 * Applies the control plane's human-mutation rule (`resources.mutate` in the organization role
 * matrix): a person changes runtime state only with a role that permits it; platform
 * administrators are exempt. Reads, including POST searches and read-scoped session or URL
 * grants, stay open to every active member.
 */
export function requireHumanRouteRole(principal: RuntimeHumanPrincipal, requiredScope: string) {
  if (requiredScope.endsWith(":read") || principal.platformAdministrator) return;
  const action = requiredScope.endsWith(":erase") ? "conversations.erase" : "resources.mutate";
  if (!organizationRoleAllows(principal.organizationRole, action)) {
    throw new RuntimeApiError(
      403,
      "insufficient_role",
      `${action === "conversations.erase" ? "Erasing data" : "Mutating organization resources"} requires one of these organization roles: ${organizationRolesAllowing(action).join(", ")}.`,
    );
  }
}
