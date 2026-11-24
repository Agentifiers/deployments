import { credentialScopePermits, platformScopePermits } from "@deployments-ai/identity/scopes";
import { Schema } from "effect";
import { type DynamoDatabaseService } from "./client-types.ts";
import type { ProtectedEnvelope } from "./identity/record-builders.ts";
import { Ulid } from "./ids.ts";
import type { OrganizationCreationPolicy } from "./tenancy/organization-creation-policy.ts";
import {
  PersistenceError,
  type PersistenceIdentity,
  type PersistenceInvocation,
  type PersistenceListResult,
} from "./persistence-types.ts";
import { PrincipalRecord, WorkspaceRecord } from "./records/control.ts";
import {
  ApiCredentialRecord,
  EnvironmentRecord,
  OrganizationInvitationRecord,
  OrganizationMemberRecord,
  OrganizationRecord,
  ProjectRecord,
  ServiceAccountRecord,
} from "./records/tenancy.ts";

export type Organization = typeof OrganizationRecord.Type;
export type OrganizationMember = typeof OrganizationMemberRecord.Type;
export type OrganizationInvitation = typeof OrganizationInvitationRecord.Type;
export type Principal = typeof PrincipalRecord.Type;
export type Project = typeof ProjectRecord.Type;
export type Environment = typeof EnvironmentRecord.Type;
export type Workspace = typeof WorkspaceRecord.Type;
export type ServiceAccount = typeof ServiceAccountRecord.Type;
export type ApiCredential = typeof ApiCredentialRecord.Type;
export type TenancyRecord =
  | Organization
  | Project
  | Environment
  | Workspace
  | ServiceAccount
  | ApiCredential;

export type OrganizationResult = Organization["data"];
export type ProjectResult = Project["data"];
export type EnvironmentResult = Omit<Environment["data"], "kind"> & {
  readonly type: Environment["data"]["kind"];
};
export type WorkspaceResult = Workspace["data"];
export type OrganizationMemberResult = Omit<OrganizationMember["data"], "removedByPrincipalId"> & {
  readonly id: OrganizationMember["data"]["principalId"];
  readonly displayName?: string;
  readonly primaryEmail?: string;
};
export type OrganizationInvitationResult = Omit<OrganizationInvitation["data"], "tokenHash">;
export type IssuedOrganizationInvitationResult = OrganizationInvitationResult & {
  readonly secretVisibleOnce: true;
  readonly token: string;
};
export type ServiceAccountResult = ServiceAccount["data"];
export type ApiCredentialResult = Omit<ApiCredential["data"], "credentialHash">;
export type IssuedApiCredentialResult = ApiCredentialResult & {
  readonly secret: string;
  readonly secretVisibleOnce: true;
};

export interface CreateOrganizationInput {
  readonly name: string;
  readonly slug?: string | undefined;
}

export interface UpdateOrganizationInput {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly slug?: string | undefined;
}

export interface UpdateProjectInput {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
}

export interface CreateEnvironmentInput {
  readonly name: string;
  readonly slug?: string | undefined;
  readonly type: Environment["data"]["kind"];
}

export interface UpdateEnvironmentInput {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
}

export interface CreateWorkspaceInput {
  readonly description?: string | undefined;
  readonly name: string;
  readonly slug?: string | undefined;
}

export interface UpdateWorkspaceInput {
  readonly description?: string | null | undefined;
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
}

export type OrganizationRole = OrganizationMember["data"]["role"];

export interface AddOrganizationMemberInput {
  readonly principalId: string;
  readonly role: OrganizationRole;
}

export interface UpdateOrganizationMemberInput {
  readonly role: OrganizationRole;
}

export interface CreateOrganizationInvitationInput {
  readonly email: string;
  readonly expiresAt?: string | undefined;
  readonly role: OrganizationRole;
}

export interface AcceptOrganizationInvitationInput {
  readonly token: string;
}

export interface CreateServiceAccountInput {
  readonly description?: string | undefined;
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface CreateApiCredentialInput {
  readonly expiresAt?: string | undefined;
  readonly name: string;
  readonly scopes?: readonly string[] | undefined;
  readonly serviceAccountId: string;
}

export interface RotateApiCredentialInput {
  readonly reason?: string | undefined;
}

export interface RevokeResourceInput {
  readonly reason?: string | undefined;
}

export interface OrganizationPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<OrganizationResult>>;
  create(invocation: PersistenceInvocation<CreateOrganizationInput>): Promise<OrganizationResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<OrganizationResult>;
  update(invocation: PersistenceInvocation<UpdateOrganizationInput>): Promise<OrganizationResult>;
}

export interface ProjectPersistence {
  list(invocation: PersistenceInvocation<undefined>): Promise<PersistenceListResult<ProjectResult>>;
  create(invocation: PersistenceInvocation<CreateProjectInput>): Promise<ProjectResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<ProjectResult>;
  update(invocation: PersistenceInvocation<UpdateProjectInput>): Promise<ProjectResult>;
  archive(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<ProjectResult>;
}

export interface EnvironmentPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<EnvironmentResult>>;
  create(invocation: PersistenceInvocation<CreateEnvironmentInput>): Promise<EnvironmentResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<EnvironmentResult>;
  update(invocation: PersistenceInvocation<UpdateEnvironmentInput>): Promise<EnvironmentResult>;
  archive(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<EnvironmentResult>;
}

export interface WorkspacePersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<WorkspaceResult>>;
  create(invocation: PersistenceInvocation<CreateWorkspaceInput>): Promise<WorkspaceResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<WorkspaceResult>;
  update(invocation: PersistenceInvocation<UpdateWorkspaceInput>): Promise<WorkspaceResult>;
  archive(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<WorkspaceResult>;
}

export interface OrganizationMemberPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<OrganizationMemberResult>>;
  add(
    invocation: PersistenceInvocation<AddOrganizationMemberInput>,
  ): Promise<OrganizationMemberResult>;
  update(
    invocation: PersistenceInvocation<UpdateOrganizationMemberInput>,
  ): Promise<OrganizationMemberResult>;
  remove(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<OrganizationMemberResult>;
}

export interface OrganizationInvitationPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<OrganizationInvitationResult>>;
  create(
    invocation: PersistenceInvocation<CreateOrganizationInvitationInput>,
  ): Promise<IssuedOrganizationInvitationResult>;
  revoke(
    invocation: PersistenceInvocation<RevokeResourceInput>,
  ): Promise<OrganizationInvitationResult>;
  accept(
    invocation: PersistenceInvocation<AcceptOrganizationInvitationInput>,
  ): Promise<OrganizationMemberResult>;
}

export interface ServiceAccountPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<ServiceAccountResult>>;
  create(
    invocation: PersistenceInvocation<CreateServiceAccountInput>,
  ): Promise<ServiceAccountResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<ServiceAccountResult>;
  revoke(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<ServiceAccountResult>;
}

export interface ApiCredentialPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<ApiCredentialResult>>;
  create(
    invocation: PersistenceInvocation<CreateApiCredentialInput>,
  ): Promise<IssuedApiCredentialResult>;
  rotate(
    invocation: PersistenceInvocation<RotateApiCredentialInput>,
  ): Promise<IssuedApiCredentialResult>;
  revoke(invocation: PersistenceInvocation<RevokeResourceInput>): Promise<ApiCredentialResult>;
}

export interface TenancyPersistence {
  authorize(
    invocation: PersistenceInvocation,
    operationName?: string,
    mutation?: boolean,
  ): Promise<void>;
  readonly organizations: OrganizationPersistence;
  readonly organizationMembers: OrganizationMemberPersistence;
  readonly organizationInvitations: OrganizationInvitationPersistence;
  readonly projects: ProjectPersistence;
  readonly environments: EnvironmentPersistence;
  readonly workspaces: WorkspacePersistence;
  readonly serviceAccounts: ServiceAccountPersistence;
  readonly apiCredentials: ApiCredentialPersistence;
}

export interface TenancyPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<string>;
  readonly generateInvitationToken?: (invitationId: string) => string;
  readonly generateSecret?: (credentialId: string) => string;
  /**
   * When configured, invitation creation also commits a protected invitation email delivery to
   * the identity email outbox in the same transaction. Absent, invitations only return the token.
   */
  readonly invitationEmail?: InvitationEmailDependency;
  /** Fences organization creation. Absent, any signed-in person may create organizations. */
  readonly organizationCreation?: OrganizationCreationPolicy;
  readonly now?: () => Date;
}

export interface InvitationEmailDependency {
  /** Envelope-encrypts the delivery payload; the adapter adds the stage to the binding. */
  readonly encryptPayload: (
    value: unknown,
    binding: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
}

export class InvalidTenancyCursorError extends Schema.TaggedErrorClass<InvalidTenancyCursorError>()(
  "InvalidTenancyCursorError",
  { message: Schema.String },
) {}

export type CursorIndex = "base" | "gsi1" | "gsi2";

export function invalidCursor() {
  return new InvalidTenancyCursorError({ message: "The tenancy cursor is invalid." });
}

export function delegatedScopes(
  identity: Pick<PersistenceIdentity, "authentication" | "scopes">,
  requested: readonly string[],
) {
  const { scopes } = identity;
  const holds =
    identity.authentication === "api-credential" ? credentialScopePermits : platformScopePermits;
  if (scopes && requested.some((scope) => !holds(scopes, scope))) {
    throw new PersistenceError(
      "unprocessable",
      "invalid_scope",
      "Delegated scopes must be a subset of the authenticated identity scopes.",
    );
  }
  return requested;
}

export function resolveSlug(input: { readonly name: string; readonly slug?: string }) {
  return (input.slug ?? input.name)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

export function organizationResult(input: Organization["data"]) {
  return {
    ...(input.billingAccountId ? { billingAccountId: input.billingAccountId } : {}),
    createdAt: input.createdAt,
    id: input.id,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    name: input.name,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function projectResult(input: Project["data"]) {
  return {
    createdAt: input.createdAt,
    id: input.id,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    name: input.name,
    organizationId: input.organizationId,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function environmentResult(input: Environment["data"]) {
  return {
    createdAt: input.createdAt,
    id: input.id,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    slug: input.slug,
    status: input.status,
    type: input.kind,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function workspaceResult(input: Workspace["data"]): WorkspaceResult {
  return {
    createdAt: input.createdAt,
    ...(input.createdByPrincipalId ? { createdByPrincipalId: input.createdByPrincipalId } : {}),
    ...(input.description ? { description: input.description } : {}),
    environmentId: input.environmentId,
    id: input.id,
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function organizationMemberResult(
  input: OrganizationMember["data"],
  principal?: Principal["data"],
): OrganizationMemberResult {
  const displayName =
    principal?.displayName &&
    principal.displayName === principal.displayName.trim() &&
    principal.displayName.length <= 120
      ? principal.displayName
      : undefined;
  const primaryEmail = principal?.primaryEmail?.trim().toLowerCase();
  const validPrimaryEmail =
    primaryEmail && primaryEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(primaryEmail)
      ? primaryEmail
      : undefined;
  return {
    createdAt: input.createdAt,
    ...(displayName ? { displayName } : {}),
    id: input.principalId,
    ...(input.invitedAt ? { invitedAt: input.invitedAt } : {}),
    ...(input.joinedAt ? { joinedAt: input.joinedAt } : {}),
    organizationId: input.organizationId,
    ...(validPrimaryEmail ? { primaryEmail: validPrimaryEmail } : {}),
    principalId: input.principalId,
    ...(input.removedAt ? { removedAt: input.removedAt } : {}),
    role: input.role,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function organizationInvitationResult(
  input: OrganizationInvitation["data"],
  timestamp = Date.now(),
): OrganizationInvitationResult {
  return {
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
    ...(input.acceptedByPrincipalId ? { acceptedByPrincipalId: input.acceptedByPrincipalId } : {}),
    createdAt: input.createdAt,
    email: input.email,
    expiresAt: input.expiresAt,
    id: input.id,
    invitedByPrincipalId: input.invitedByPrincipalId,
    organizationId: input.organizationId,
    ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    role: input.role,
    status:
      input.status === "pending" && Date.parse(input.expiresAt) <= timestamp
        ? "expired"
        : input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function serviceAccountResult(input: ServiceAccount["data"]) {
  return {
    createdAt: input.createdAt,
    ...(input.createdByPrincipalId ? { createdByPrincipalId: input.createdByPrincipalId } : {}),
    ...(input.description ? { description: input.description } : {}),
    environmentId: input.environmentId,
    id: input.id,
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    scopes: input.scopes,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function apiCredentialProjection(input: ApiCredential["data"]) {
  return {
    createdAt: input.createdAt,
    environmentId: input.environmentId,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    id: input.id,
    keyPrefix: input.keyPrefix,
    ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    scopes: input.scopes,
    serviceAccountId: input.serviceAccountId,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function apiCredentialResult(input: ApiCredential["data"]) {
  return apiCredentialProjection(input);
}

export function issuedApiCredentialResult(input: ApiCredential["data"], secret: string) {
  return { ...apiCredentialProjection(input), secret, secretVisibleOnce: true as const };
}

export function id(value: string): Ulid {
  return Schema.decodeUnknownSync(Ulid)(value);
}

export function identityOrganizations(
  identity: PersistenceInvocation["identity"],
): readonly Ulid[] | "*" | undefined {
  if (identity.organizationIds === "*") return "*";
  return identity.organizationIds?.map(id);
}

export function assertIdentityGrant(
  values: readonly string[] | "*" | undefined,
  resourceId: Ulid,
  scope: "project" | "environment",
) {
  // Missing lower-level claims represent organization-wide member access; explicit claims narrow it.
  if (values === "*" || values === undefined || values.some((value) => value === resourceId)) {
    return;
  }
  throw new PersistenceError(
    "forbidden",
    `${scope}_scope_violation`,
    `The credential cannot access the requested ${scope}.`,
  );
}

export function assertCollectionGrant(
  values: readonly string[] | "*" | undefined,
  scope: "project" | "environment",
) {
  if (values === "*" || values === undefined) return;
  throw new PersistenceError(
    "forbidden",
    `${scope}_scope_violation`,
    `The credential cannot access the requested ${scope} collection.`,
  );
}

export function requiredResourceId(invocation: PersistenceInvocation): Ulid {
  if (!invocation.id) {
    throw new PersistenceError(
      "invalid-input",
      "resource_id_required",
      "A resource identifier is required.",
    );
  }
  return id(invocation.id);
}
