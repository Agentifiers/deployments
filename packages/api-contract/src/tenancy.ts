import { Schema } from "effect";
import {
  Cursor,
  EmailAddress,
  Metadata,
  PublicId,
  ResourceDescription,
  ResourceName,
  ScopeList,
  Slug,
  Timestamp,
} from "./primitives.ts";

export const ResourceStatus = Schema.Literals(["active", "archived", "disabled"]);
export const EnvironmentType = Schema.Literals(["custom", "development", "production", "staging"]);
export const ApiCredentialStatus = Schema.Literals(["active", "expired", "revoked"]);

const mutableFields = {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1, { message: "Resource versions must start at 1." }),
    ),
  ),
} as const;

const tenantFields = {
  environmentId: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
} as const;

export const CreateOrganizationRequest = Schema.Struct({
  name: ResourceName,
  slug: Schema.optional(Slug),
});
export const UpdateOrganizationRequest = Schema.Struct({
  name: Schema.optional(ResourceName),
  slug: Schema.optional(Slug),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, { message: "Organization updates must change one field." }),
  ),
);
export const OrganizationResponse = Schema.Struct({
  ...mutableFields,
  billingAccountId: Schema.optional(PublicId),
  id: PublicId,
  metadata: Schema.optional(Metadata),
  name: ResourceName,
  slug: Slug,
  status: ResourceStatus,
});

export const OrganizationRole = Schema.Literals(["admin", "billing", "member", "owner", "viewer"]);

export const AddOrganizationMemberRequest = Schema.Struct({
  principalId: PublicId,
  role: OrganizationRole,
});
export const UpdateOrganizationMemberRequest = Schema.Struct({
  role: OrganizationRole,
});
export const OrganizationMemberResponse = Schema.Struct({
  ...mutableFields,
  displayName: Schema.optional(ResourceName),
  id: PublicId,
  invitedAt: Schema.optional(Timestamp),
  joinedAt: Schema.optional(Timestamp),
  organizationId: PublicId,
  primaryEmail: Schema.optional(EmailAddress),
  principalId: PublicId,
  removedAt: Schema.optional(Timestamp),
  role: OrganizationRole,
  status: Schema.Literals(["active", "invited", "removed"]),
});

export const InvitationToken = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Invitation tokens must not contain surrounding whitespace." }),
    Schema.isMinLength(1, { message: "Invitation tokens must not be empty." }),
    Schema.isMaxLength(1_024, { message: "Invitation tokens must not exceed 1024 characters." }),
  ),
);
export const CreateOrganizationInvitationRequest = Schema.Struct({
  email: EmailAddress,
  expiresAt: Schema.optional(Timestamp),
  role: OrganizationRole,
});
export const AcceptOrganizationInvitationRequest = Schema.Struct({
  token: InvitationToken,
});
export const OrganizationInvitationResponse = Schema.Struct({
  ...mutableFields,
  acceptedAt: Schema.optional(Timestamp),
  acceptedByPrincipalId: Schema.optional(PublicId),
  email: EmailAddress,
  expiresAt: Timestamp,
  id: PublicId,
  invitedByPrincipalId: PublicId,
  organizationId: PublicId,
  revokedAt: Schema.optional(Timestamp),
  role: OrganizationRole,
  status: Schema.Literals(["accepted", "expired", "pending", "revoked"]),
});
export const IssuedOrganizationInvitationResponse = Schema.Struct({
  ...OrganizationInvitationResponse.fields,
  secretVisibleOnce: Schema.Literal(true),
  token: InvitationToken,
});

export const CreateProjectRequest = Schema.Struct({
  name: ResourceName,
  slug: Schema.optional(Slug),
});
export const UpdateProjectRequest = Schema.Struct({
  name: Schema.optional(ResourceName),
  slug: Schema.optional(Slug),
}).pipe(
  Schema.check(Schema.isMinProperties(1, { message: "Project updates must change one field." })),
);
export const ProjectResponse = Schema.Struct({
  ...mutableFields,
  id: PublicId,
  metadata: Schema.optional(Metadata),
  name: ResourceName,
  organizationId: PublicId,
  slug: Slug,
  status: ResourceStatus,
});

export const CreateEnvironmentRequest = Schema.Struct({
  name: ResourceName,
  slug: Schema.optional(Slug),
  type: EnvironmentType,
});
export const UpdateEnvironmentRequest = Schema.Struct({
  name: Schema.optional(ResourceName),
  slug: Schema.optional(Slug),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, { message: "Environment updates must change one field." }),
  ),
);
export const EnvironmentResponse = Schema.Struct({
  ...mutableFields,
  id: PublicId,
  metadata: Schema.optional(Metadata),
  name: ResourceName,
  organizationId: PublicId,
  projectId: PublicId,
  slug: Slug,
  status: ResourceStatus,
  type: EnvironmentType,
});

export const CreateWorkspaceRequest = Schema.Struct({
  description: Schema.optional(ResourceDescription),
  name: ResourceName,
  slug: Schema.optional(Slug),
});
export const UpdateWorkspaceRequest = Schema.Struct({
  description: Schema.optional(Schema.NullOr(ResourceDescription)),
  name: Schema.optional(ResourceName),
  slug: Schema.optional(Slug),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, { message: "Workspace updates must change at least one field." }),
  ),
);
export const WorkspaceResponse = Schema.Struct({
  ...mutableFields,
  ...tenantFields,
  createdByPrincipalId: Schema.optional(PublicId),
  description: Schema.optional(ResourceDescription),
  id: PublicId,
  name: ResourceName,
  slug: Slug,
  status: ResourceStatus,
});

export const CreateServiceAccountRequest = Schema.Struct({
  description: Schema.optional(ResourceDescription),
  name: ResourceName,
  scopes: ScopeList.pipe(
    Schema.check(
      Schema.isMinLength(1, { message: "Service accounts require at least one scope." }),
    ),
  ),
});
export const ServiceAccountResponse = Schema.Struct({
  ...mutableFields,
  ...tenantFields,
  createdByPrincipalId: Schema.optional(PublicId),
  description: Schema.optional(ResourceDescription),
  id: PublicId,
  name: ResourceName,
  scopes: ScopeList,
  status: ResourceStatus,
});

export const CreateApiCredentialRequest = Schema.Struct({
  expiresAt: Schema.optional(Timestamp),
  name: ResourceName,
  scopes: Schema.optional(ScopeList),
  serviceAccountId: PublicId,
});
export const RotateApiCredentialRequest = Schema.Struct({
  reason: Schema.optional(ResourceDescription),
});
export const RevokeResourceRequest = Schema.Struct({
  reason: Schema.optional(ResourceDescription),
});

const apiCredentialFields = {
  ...mutableFields,
  ...tenantFields,
  expiresAt: Schema.optional(Timestamp),
  id: PublicId,
  keyPrefix: Schema.String,
  lastUsedAt: Schema.optional(Timestamp),
  name: ResourceName,
  revokedAt: Schema.optional(Timestamp),
  scopes: ScopeList,
  serviceAccountId: PublicId,
  status: ApiCredentialStatus,
} as const;

export const ApiCredentialResponse = Schema.Struct(apiCredentialFields);
export const IssuedApiCredentialResponse = Schema.Struct({
  ...apiCredentialFields,
  secret: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((input) =>
        input.length > 0 ? undefined : "Issued API credential secrets must not be empty.",
      ),
    ),
  ),
  secretVisibleOnce: Schema.Literal(true),
});

export const ListOrganizationsResponse = Schema.Struct({
  items: Schema.Array(OrganizationResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListOrganizationMembersResponse = Schema.Struct({
  items: Schema.Array(OrganizationMemberResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListOrganizationInvitationsResponse = Schema.Struct({
  items: Schema.Array(OrganizationInvitationResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListProjectsResponse = Schema.Struct({
  items: Schema.Array(ProjectResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListEnvironmentsResponse = Schema.Struct({
  items: Schema.Array(EnvironmentResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListWorkspacesResponse = Schema.Struct({
  items: Schema.Array(WorkspaceResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListServiceAccountsResponse = Schema.Struct({
  items: Schema.Array(ServiceAccountResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListApiCredentialsResponse = Schema.Struct({
  items: Schema.Array(ApiCredentialResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export type CreateOrganizationRequest = typeof CreateOrganizationRequest.Type;
export type UpdateOrganizationRequest = typeof UpdateOrganizationRequest.Type;
export type OrganizationResponse = typeof OrganizationResponse.Type;
export type OrganizationRole = typeof OrganizationRole.Type;
export type AddOrganizationMemberRequest = typeof AddOrganizationMemberRequest.Type;
export type UpdateOrganizationMemberRequest = typeof UpdateOrganizationMemberRequest.Type;
export type OrganizationMemberResponse = typeof OrganizationMemberResponse.Type;
export type CreateOrganizationInvitationRequest = typeof CreateOrganizationInvitationRequest.Type;
export type AcceptOrganizationInvitationRequest = typeof AcceptOrganizationInvitationRequest.Type;
export type OrganizationInvitationResponse = typeof OrganizationInvitationResponse.Type;
export type IssuedOrganizationInvitationResponse = typeof IssuedOrganizationInvitationResponse.Type;
export type CreateProjectRequest = typeof CreateProjectRequest.Type;
export type UpdateProjectRequest = typeof UpdateProjectRequest.Type;
export type ProjectResponse = typeof ProjectResponse.Type;
export type CreateEnvironmentRequest = typeof CreateEnvironmentRequest.Type;
export type UpdateEnvironmentRequest = typeof UpdateEnvironmentRequest.Type;
export type EnvironmentResponse = typeof EnvironmentResponse.Type;
export type CreateWorkspaceRequest = typeof CreateWorkspaceRequest.Type;
export type UpdateWorkspaceRequest = typeof UpdateWorkspaceRequest.Type;
export type WorkspaceResponse = typeof WorkspaceResponse.Type;
export type CreateServiceAccountRequest = typeof CreateServiceAccountRequest.Type;
export type ServiceAccountResponse = typeof ServiceAccountResponse.Type;
export type CreateApiCredentialRequest = typeof CreateApiCredentialRequest.Type;
export type RotateApiCredentialRequest = typeof RotateApiCredentialRequest.Type;
export type RevokeResourceRequest = typeof RevokeResourceRequest.Type;
export type ApiCredentialResponse = typeof ApiCredentialResponse.Type;
export type IssuedApiCredentialResponse = typeof IssuedApiCredentialResponse.Type;

interface OrganizationProjectionInput extends Record<string, unknown> {
  readonly billingAccountId?: string;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface ProjectProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface EnvironmentProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly id: string;
  readonly kind?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly status: string;
  readonly type?: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface WorkspaceProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly createdByPrincipalId?: string;
  readonly description?: string;
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface OrganizationMemberProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly displayName?: string;
  readonly id?: string;
  readonly invitedAt?: string;
  readonly joinedAt?: string;
  readonly organizationId: string;
  readonly primaryEmail?: string;
  readonly principalId: string;
  readonly removedAt?: string;
  readonly role: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface OrganizationInvitationProjectionInput extends Record<string, unknown> {
  readonly acceptedAt?: string;
  readonly acceptedByPrincipalId?: string;
  readonly createdAt: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly invitedByPrincipalId: string;
  readonly organizationId: string;
  readonly revokedAt?: string;
  readonly role: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface ServiceAccountProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly createdByPrincipalId?: string;
  readonly description?: string;
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

interface ApiCredentialProjectionInput extends Record<string, unknown> {
  readonly createdAt: string;
  readonly environmentId: string;
  readonly expiresAt?: string;
  readonly id: string;
  readonly keyPrefix: string;
  readonly lastUsedAt?: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly revokedAt?: string;
  readonly scopes: readonly string[];
  readonly serviceAccountId: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly version: number;
}

function optional<Value>(value: Value | undefined, key: string) {
  return value === undefined ? {} : { [key]: value };
}

export function organizationResponse(input: OrganizationProjectionInput): OrganizationResponse {
  return Schema.decodeUnknownSync(OrganizationResponse)({
    ...optional(input.billingAccountId, "billingAccountId"),
    createdAt: input.createdAt,
    id: input.id,
    ...optional(input.metadata, "metadata"),
    name: input.name,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function projectResponse(input: ProjectProjectionInput): ProjectResponse {
  return Schema.decodeUnknownSync(ProjectResponse)({
    createdAt: input.createdAt,
    id: input.id,
    ...optional(input.metadata, "metadata"),
    name: input.name,
    organizationId: input.organizationId,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function environmentResponse(input: EnvironmentProjectionInput): EnvironmentResponse {
  return Schema.decodeUnknownSync(EnvironmentResponse)({
    createdAt: input.createdAt,
    id: input.id,
    ...optional(input.metadata, "metadata"),
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    slug: input.slug,
    status: input.status,
    type: input.type ?? input.kind,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function workspaceResponse(input: WorkspaceProjectionInput): WorkspaceResponse {
  return Schema.decodeUnknownSync(WorkspaceResponse)({
    createdAt: input.createdAt,
    ...optional(input.createdByPrincipalId, "createdByPrincipalId"),
    ...optional(input.description, "description"),
    environmentId: input.environmentId,
    id: input.id,
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function organizationMemberResponse(
  input: OrganizationMemberProjectionInput,
): OrganizationMemberResponse {
  return Schema.decodeUnknownSync(OrganizationMemberResponse)({
    createdAt: input.createdAt,
    ...optional(input.displayName, "displayName"),
    id: input.id ?? input.principalId,
    ...optional(input.invitedAt, "invitedAt"),
    ...optional(input.joinedAt, "joinedAt"),
    organizationId: input.organizationId,
    ...optional(input.primaryEmail, "primaryEmail"),
    principalId: input.principalId,
    ...optional(input.removedAt, "removedAt"),
    role: input.role,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function organizationInvitationResponse(
  input: OrganizationInvitationProjectionInput,
): OrganizationInvitationResponse {
  return Schema.decodeUnknownSync(OrganizationInvitationResponse)({
    ...optional(input.acceptedAt, "acceptedAt"),
    ...optional(input.acceptedByPrincipalId, "acceptedByPrincipalId"),
    createdAt: input.createdAt,
    email: input.email,
    expiresAt: input.expiresAt,
    id: input.id,
    invitedByPrincipalId: input.invitedByPrincipalId,
    organizationId: input.organizationId,
    ...optional(input.revokedAt, "revokedAt"),
    role: input.role,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function serviceAccountResponse(
  input: ServiceAccountProjectionInput,
): ServiceAccountResponse {
  return Schema.decodeUnknownSync(ServiceAccountResponse)({
    createdAt: input.createdAt,
    ...optional(input.createdByPrincipalId, "createdByPrincipalId"),
    ...optional(input.description, "description"),
    environmentId: input.environmentId,
    id: input.id,
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    scopes: [...input.scopes],
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function apiCredentialResponse(input: ApiCredentialProjectionInput): ApiCredentialResponse {
  return Schema.decodeUnknownSync(ApiCredentialResponse)({
    createdAt: input.createdAt,
    environmentId: input.environmentId,
    ...optional(input.expiresAt, "expiresAt"),
    id: input.id,
    keyPrefix: input.keyPrefix,
    ...optional(input.lastUsedAt, "lastUsedAt"),
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...optional(input.revokedAt, "revokedAt"),
    scopes: [...input.scopes],
    serviceAccountId: input.serviceAccountId,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
  });
}

export function issuedApiCredentialResponse(
  input: ApiCredentialProjectionInput,
  secret: string,
): IssuedApiCredentialResponse {
  return Schema.decodeUnknownSync(IssuedApiCredentialResponse)({
    ...apiCredentialResponse(input),
    secret,
    secretVisibleOnce: true,
  });
}
