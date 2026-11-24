import { createHash, timingSafeEqual } from "node:crypto";
import {
  DIRECTORY_TOKEN_PREFIX,
  Keys,
  Ulid,
  admittedOrganizationScopes,
  key,
  organizationAccess,
  type DynamoDatabaseService,
  type PlatformRecord,
  apiPersistence,
} from "@deployments-ai/db";
import {
  createPlatformJwtVerifier,
  isJwtBearerToken,
  platformJwtClaims,
  resolvePlatformJwtClaimProfile,
  type JwtAuthenticationOptions,
  type PlatformJwtClaimProfile,
} from "@deployments-ai/identity/platform-jwt";
import { credentialScopePermits } from "@deployments-ai/identity/scopes";
import type { JWTPayload } from "jose";
import { Schema } from "effect";
import type { ApiIdentity } from "./index.ts";
import { isPlatformAdministrator } from "./scope-permissions.ts";

type ApiCredential = Extract<PlatformRecord, { readonly itemType: "api-credential" }>;
type Environment = Extract<PlatformRecord, { readonly itemType: "environment" }>;
type Project = Extract<PlatformRecord, { readonly itemType: "project" }>;
type Principal = Extract<PlatformRecord, { readonly itemType: "principal" }>;
type ServiceAccount = Extract<PlatformRecord, { readonly itemType: "service-account" }>;

export interface ApplicationAuthenticatorOptions {
  readonly database: DynamoDatabaseService;
  readonly jwt: JwtAuthenticationOptions;
  readonly now?: () => Date;
}

export interface MemoryJwtIdentityAuthenticatorOptions {
  readonly jwt: JwtAuthenticationOptions;
}

export class OrganizationSsoRequiredError extends Error {
  constructor(readonly organizationId: string) {
    super("The organization requires single sign-on.");
    this.name = "OrganizationSsoRequiredError";
  }
}

/** A platform administrator selected an organization without open operator access to it. */
export class OperatorAccessRequiredError extends Error {
  constructor(readonly organizationId: string) {
    super(
      "Platform administrators need open operator access to this organization. Open access from the system organization page or with `deployments system access-open`, then retry.",
    );
    this.name = "OperatorAccessRequiredError";
  }
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const PLATFORM_WIDE_SCOPES: ReadonlySet<string> = new Set(["platform:*", "platform:admin"]);

function credentialHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function exactHash(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function getRecord(
  database: DynamoDatabaseService,
  table: "control",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return apiPersistence.read(database, table, recordKey, true);
}

function ulid(value: unknown): string | undefined {
  try {
    return String(Schema.decodeUnknownSync(Ulid)(value));
  } catch {
    return undefined;
  }
}

function intersectScopes(credentialScopes: readonly string[], accountScopes: readonly string[]) {
  const candidates = new Set([...credentialScopes, ...accountScopes]);
  return [...candidates].filter(
    (candidate) =>
      credentialScopePermits(credentialScopes, candidate) &&
      credentialScopePermits(accountScopes, candidate),
  );
}

function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || undefined;
}

function erasureReceiptOrganizationId(request: Request) {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  const receiptRead =
    request.method === "GET" &&
    path.length === 5 &&
    path[0] === "v1" &&
    path[1] === "organizations" &&
    path[3] === "erasures";
  const receiptReplay =
    request.method === "POST" &&
    path.length === 4 &&
    path[0] === "v1" &&
    path[1] === "organizations" &&
    path[3] === "erasures";
  return receiptRead || receiptReplay ? path[2] : undefined;
}

function isApiCredential(record: PlatformRecord | undefined): record is ApiCredential {
  return record?.itemType === "api-credential";
}

function isServiceAccount(record: PlatformRecord | undefined): record is ServiceAccount {
  return record?.itemType === "service-account";
}

async function opaqueIdentity(
  token: string,
  database: DynamoDatabaseService,
  now: Date,
): Promise<ApiIdentity | null> {
  const hash = credentialHash(token);
  const claim = await getRecord(
    database,
    "control",
    Keys.control.uniqueClaim("api-credential-hash", hash),
  );
  if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "api-credential") {
    return null;
  }
  const credential = await getRecord(database, "control", {
    pk: claim.data.ownerPk,
    sk: claim.data.ownerSk,
  });
  if (
    !isApiCredential(credential) ||
    credential.data.status !== "active" ||
    credential.data.revokedAt !== undefined ||
    (credential.data.expiresAt !== undefined &&
      Date.parse(credential.data.expiresAt) <= now.getTime()) ||
    !exactHash(credential.data.credentialHash, hash)
  ) {
    return null;
  }
  const serviceAccount = await getRecord(database, "control", {
    pk: key("ORG", credential.data.organizationId, "ENV", credential.data.environmentId),
    sk: key("SERVICE-ACCOUNT", credential.data.serviceAccountId),
  });
  if (
    !isServiceAccount(serviceAccount) ||
    serviceAccount.data.status !== "active" ||
    serviceAccount.data.organizationId !== credential.data.organizationId ||
    serviceAccount.data.projectId !== credential.data.projectId ||
    serviceAccount.data.environmentId !== credential.data.environmentId
  ) {
    return null;
  }
  return {
    apiCredentialId: credential.data.id,
    authentication: "api-credential",
    opaqueCredential: true,
    principalId: serviceAccount.data.id,
    scopes: intersectScopes(credential.data.scopes, serviceAccount.data.scopes),
    organizationIds: [credential.data.organizationId],
    projectIds: [credential.data.projectId],
    environmentIds: [credential.data.environmentId],
  };
}

function jwtIdentity(
  payload: JWTPayload,
  claimProfile: PlatformJwtClaimProfile,
): ApiIdentity | null {
  const claims = platformJwtClaims(payload, claimProfile);
  if (!claims) return null;
  return {
    authentication: "tenant-jwt",
    principalId: claims.principalId,
    scopes: claims.scopes,
    ...(claims.emailVerified ? { emailVerified: true } : {}),
    ...(claims.organizationId ? { organizationIds: [claims.organizationId] } : {}),
    ...(claims.projectId ? { projectIds: [claims.projectId] } : {}),
    ...(claims.environmentId ? { environmentIds: [claims.environmentId] } : {}),
    ...(claims.tokenSessionId ? { tokenSessionId: decodeUlid(claims.tokenSessionId) } : {}),
  };
}

async function activeHumanPrincipal(
  principalId: string,
  database: DynamoDatabaseService,
): Promise<Principal | undefined> {
  const principal = await getRecord(database, "control", {
    pk: key("PRINCIPAL", principalId),
    sk: key("PRINCIPAL", principalId),
  });
  return principal?.itemType === "principal" &&
    principal.data.kind === "human" &&
    principal.data.status === "active"
    ? principal
    : undefined;
}

async function claimedRecord<RecordType extends Environment | Project>(
  database: DynamoDatabaseService,
  itemType: RecordType["itemType"],
  resourceId: string,
): Promise<RecordType | undefined> {
  const claim = await getRecord(
    database,
    "control",
    Keys.control.uniqueClaim(`${itemType}-id`, resourceId),
  );
  if (
    claim?.itemType !== "unique-claim" ||
    claim.data.ownerItemType !== itemType ||
    claim.data.ownerId !== resourceId
  ) {
    return undefined;
  }
  const record = await getRecord(database, "control", {
    pk: claim.data.ownerPk,
    sk: claim.data.ownerSk,
  });
  return record?.itemType === itemType ? (record as RecordType) : undefined;
}

async function resolveJwtHierarchy(
  identity: ApiIdentity,
  database: DynamoDatabaseService,
): Promise<ApiIdentity | null> {
  const environmentId =
    identity.environmentIds !== "*" && identity.environmentIds?.length === 1
      ? identity.environmentIds[0]
      : undefined;
  if (environmentId) {
    const environment = await claimedRecord<Environment>(database, "environment", environmentId);
    if (!environment) return null;
    const claimedProject =
      identity.projectIds !== "*" && identity.projectIds?.length === 1
        ? identity.projectIds[0]
        : undefined;
    const claimedOrganization =
      identity.organizationIds !== "*" && identity.organizationIds?.length === 1
        ? identity.organizationIds[0]
        : undefined;
    if (
      (claimedProject && claimedProject !== environment.data.projectId) ||
      (claimedOrganization && claimedOrganization !== environment.data.organizationId)
    ) {
      return null;
    }
    return {
      ...identity,
      organizationIds: [environment.data.organizationId],
      projectIds: [environment.data.projectId],
    };
  }
  const projectId =
    identity.projectIds !== "*" && identity.projectIds?.length === 1
      ? identity.projectIds[0]
      : undefined;
  if (!projectId) return identity;
  const project = await claimedRecord<Project>(database, "project", projectId);
  if (!project) return null;
  const claimedOrganization =
    identity.organizationIds !== "*" && identity.organizationIds?.length === 1
      ? identity.organizationIds[0]
      : undefined;
  if (claimedOrganization && claimedOrganization !== project.data.organizationId) return null;
  return { ...identity, organizationIds: [project.data.organizationId] };
}

function requestHeaderId(request: Request, name: string) {
  const raw = request.headers.get(name)?.trim();
  if (!raw) return { present: false as const };
  const value = ulid(raw);
  return value ? { present: true as const, value } : { present: true as const };
}

function requestedJwtScope(identity: ApiIdentity, request: Request): ApiIdentity | null {
  const requestedOrganization = requestHeaderId(request, "x-deployments-organization");
  const requestedProject = requestHeaderId(request, "x-deployments-project");
  const requestedEnvironment = requestHeaderId(request, "x-deployments-environment");
  if (
    (requestedOrganization.present && !requestedOrganization.value) ||
    (requestedProject.present && !requestedProject.value) ||
    (requestedEnvironment.present && !requestedEnvironment.value)
  ) {
    return null;
  }
  const requested = [
    [requestedOrganization.value, identity.organizationIds],
    [requestedProject.value, identity.projectIds],
    [requestedEnvironment.value, identity.environmentIds],
  ] as const;
  for (const [value, grants] of requested) {
    if (value && grants !== undefined && grants !== "*" && !grants.includes(value)) return null;
  }
  return {
    ...identity,
    ...(requestedOrganization.value ? { organizationIds: [requestedOrganization.value] } : {}),
    ...(requestedProject.value ? { projectIds: [requestedProject.value] } : {}),
    ...(requestedEnvironment.value ? { environmentIds: [requestedEnvironment.value] } : {}),
    // Without an environment claim the caller selects its environment per request, so a
    // cross-environment operation may also select its declared target (still authorized there).
    ...(requestedEnvironment.value && identity.environmentIds === undefined
      ? { environmentSelection: "request" as const }
      : {}),
  };
}

async function verifyJwtMembership(
  identity: ApiIdentity,
  database: DynamoDatabaseService,
  now: Date | undefined,
): Promise<ApiIdentity | null> {
  const organizationId =
    identity.organizationIds !== "*" && identity.organizationIds?.length === 1
      ? identity.organizationIds[0]
      : undefined;
  if (!organizationId) return identity;
  const access = await organizationAccess(database, {
    organizationId: decodeUlid(organizationId),
    platformAdministrator: isPlatformAdministrator(identity),
    principalId: decodeUlid(identity.principalId),
    ...(identity.tokenSessionId ? { tokenSessionId: identity.tokenSessionId } : {}),
    ...(now ? { now } : {}),
  });
  switch (access.kind) {
    case "platform-administrator":
      return { ...identity, operatorAccess: access.operatorAccess };
    case "operator-access-required":
      throw new OperatorAccessRequiredError(organizationId);
    case "member": {
      // A member who is also a platform administrator acts as the member here.
      const { platformRole: _platformRole, ...member } = identity;
      return {
        ...member,
        organizationRole: access.role,
        scopes: admittedOrganizationScopes(
          access.role,
          identity.scopes.filter((scope) => !PLATFORM_WIDE_SCOPES.has(scope)),
        ),
      };
    }
    case "denied":
      return null;
    case "sso-required":
      throw new OrganizationSsoRequiredError(organizationId);
  }
}

export function createApplicationAuthenticator(options: ApplicationAuthenticatorOptions) {
  const verifyJwt = createPlatformJwtVerifier(options.jwt);
  const claimProfile = resolvePlatformJwtClaimProfile(options.jwt);

  return async (request: Request): Promise<ApiIdentity | null> => {
    const token = bearerToken(request);
    if (!token || token.startsWith(DIRECTORY_TOKEN_PREFIX)) return null;
    if (isJwtBearerToken(token)) {
      try {
        const identity = jwtIdentity(await verifyJwt(token), claimProfile);
        if (!identity) return null;
        const principal =
          claimProfile === "platform"
            ? await activeHumanPrincipal(identity.principalId, options.database)
            : undefined;
        if (claimProfile === "platform" && !principal) return null;
        const entitledIdentity: ApiIdentity = {
          ...identity,
          ...(principal?.data.platformRole ? { platformRole: principal.data.platformRole } : {}),
        };
        const requested = requestedJwtScope(entitledIdentity, request);
        if (!requested) return null;
        const resolved = await resolveJwtHierarchy(requested, options.database);
        const receiptOrganizationId = erasureReceiptOrganizationId(request);
        const claimedOrganizationId =
          requested.organizationIds !== "*" && requested.organizationIds?.length === 1
            ? requested.organizationIds[0]
            : undefined;
        const receiptOnly =
          receiptOrganizationId !== undefined && receiptOrganizationId === claimedOrganizationId;
        const authorized = resolved
          ? await verifyJwtMembership(resolved, options.database, options.now?.()).catch(
              (cause: unknown) => {
                // A receipt is readable without access, exactly as for a removed member.
                if (cause instanceof OperatorAccessRequiredError && receiptOnly) return null;
                throw cause;
              },
            )
          : null;
        if (authorized) return authorized;
        return receiptOnly ? { ...requested, erasureReceiptOnly: true } : null;
      } catch (cause) {
        if (
          cause instanceof OrganizationSsoRequiredError ||
          cause instanceof OperatorAccessRequiredError
        ) {
          throw cause;
        }
        return null;
      }
    }
    return opaqueIdentity(token, options.database, options.now?.() ?? new Date());
  };
}

function memoryClaim(payload: JWTPayload, name: string) {
  return payload[name] ?? payload[`custom:${name}`];
}

function memoryCapabilities(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
    }
  } catch {
    // Space- and comma-delimited values are the common JWT scope representation.
  }
  return value.split(/[\s,]+/u).filter(Boolean);
}

function memoryJwtIdentity(payload: JWTPayload): ApiIdentity | null {
  const organizationId = ulid(memoryClaim(payload, "organization_id"));
  const projectId = ulid(memoryClaim(payload, "project_id"));
  const environmentId = ulid(memoryClaim(payload, "environment_id"));
  const principalClaim = memoryClaim(payload, "principal_id");
  const principalId =
    principalClaim === undefined
      ? typeof payload.sub === "string" && payload.sub
        ? payload.sub
        : organizationId
      : ulid(principalClaim);
  const workspaceClaim = memoryClaim(payload, "workspace_id");
  const workspaceId = workspaceClaim === undefined ? undefined : ulid(workspaceClaim);
  if (
    !organizationId ||
    !projectId ||
    !environmentId ||
    !principalId ||
    (workspaceClaim !== undefined && !workspaceId)
  ) {
    return null;
  }
  const scopes = [
    ...memoryCapabilities(memoryClaim(payload, "scope")),
    ...memoryCapabilities(payload.scp),
    ...memoryCapabilities(payload.permissions),
    ...memoryCapabilities(payload.capabilities),
  ];
  return {
    authentication: "tenant-jwt",
    environmentIds: [environmentId],
    organizationIds: [organizationId],
    principalId,
    projectIds: [projectId],
    scopes: [...new Set(scopes)],
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function createMemoryJwtIdentityAuthenticator(
  options: MemoryJwtIdentityAuthenticatorOptions,
) {
  const verifyJwt = createPlatformJwtVerifier(options.jwt);
  return async (request: Request): Promise<ApiIdentity | null> => {
    const token = bearerToken(request);
    if (!token || !isJwtBearerToken(token)) return null;
    try {
      return memoryJwtIdentity(await verifyJwt(token));
    } catch {
      return null;
    }
  };
}
