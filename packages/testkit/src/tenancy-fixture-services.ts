import { ApiProblem, type TenancyApiService } from "@deployments-ai/api";
import {
  apiCredentialResponse,
  environmentResponse,
  issuedApiCredentialResponse,
  organizationInvitationResponse,
  organizationMemberResponse,
  organizationResponse,
  projectResponse,
  resolveSlug,
  serviceAccountResponse,
  workspaceResponse,
} from "@deployments-ai/api-contract";
import { createHash, randomBytes } from "node:crypto";
import type {
  ApiCredentialRecord,
  EnvironmentRecord,
  OrganizationInvitationRecord,
  OrganizationMemberRecord,
  OrganizationRecord,
  ProjectRecord,
  ServiceAccountRecord,
  TenancyFixtureContext,
  WorkspaceRecord,
} from "./index.ts";
import {} from "./index.ts";

export function makeTenancyFixtureServices(context: TenancyFixtureContext) {
  const {
    now,
    id,
    state,
    memberships,
    idempotencyValues: _idempotencyValues,
    adminToken: _adminToken,
    adminPrincipalId: _adminPrincipalId,
    identityFor: _identityFor,
    page,
    createRecord,
    createAgentRecord: _createAgentRecord,
    get,
    unique,
    updateRecord,
    assertScope,
    expectedVersion: _expectedVersion,
    environmentFor,
  } = context;

  const organizations: TenancyApiService["organizations"] = {
    async list(invocation) {
      return page(
        [...state.organizations.values()]
          .filter(
            (item) =>
              memberships.get(invocation.identity.principalId)?.has(item.id) ||
              invocation.identity.organizationIds === "*",
          )
          .map(organizationResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const body = invocation.body;
      const slug = String(
        resolveSlug({
          name: body.name,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        }),
      );
      unique(state.organizations, (item) => item.slug === slug, "Organization slug");
      const item: OrganizationRecord = createRecord({
        id: id(),
        name: body.name,
        slug,
        status: "active",
      });
      state.organizations.set(item.id, item);
      const set = memberships.get(invocation.identity.principalId) ?? new Set();
      set.add(item.id);
      memberships.set(invocation.identity.principalId, set);
      const member: OrganizationMemberRecord = createRecord({
        id: invocation.identity.principalId,
        joinedAt: now(),
        organizationId: item.id,
        principalId: invocation.identity.principalId,
        role: "owner",
        status: "active",
      });
      state.organizationMembers.set(`${item.id}:${member.principalId}`, member);
      return organizationResponse(item);
    },
    async get(invocation) {
      const item = get(state.organizations, invocation.id, "Organization");
      assertScope({ organizationId: item.id }, invocation);
      return organizationResponse(item);
    },
    async update(invocation) {
      const item = get(state.organizations, invocation.id, "Organization");
      assertScope({ organizationId: item.id }, invocation);
      const body = invocation.body;
      const slug = body.slug
        ? String(resolveSlug({ name: body.name ?? item.name, slug: body.slug }))
        : item.slug;
      unique(state.organizations, (entry) => entry.slug === slug, "Organization slug", item.id);
      const next = updateRecord(item, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        slug,
      });
      state.organizations.set(item.id, next);
      return organizationResponse(next);
    },
  };

  const organizationMembers: TenancyApiService["organizationMembers"] = {
    async list(invocation) {
      return page(
        [...state.organizationMembers.values()]
          .filter((item) => item.organizationId === invocation.scope.organizationId)
          .map(organizationMemberResponse),
        invocation.query,
      );
    },
    async add(invocation) {
      const organizationId = invocation.scope.organizationId;
      if (!organizationId)
        throw new ApiProblem(400, "missing_scope", "The organization scope is required.");
      const key = `${organizationId}:${invocation.body.principalId}`;
      if (state.organizationMembers.get(key)?.status === "active") {
        throw new ApiProblem(409, "member_exists", "The member already exists.");
      }
      const member: OrganizationMemberRecord = createRecord({
        id: invocation.body.principalId,
        joinedAt: now(),
        organizationId,
        principalId: invocation.body.principalId,
        role: invocation.body.role,
        status: "active",
      });
      state.organizationMembers.set(key, member);
      const set = memberships.get(member.principalId) ?? new Set();
      set.add(organizationId);
      memberships.set(member.principalId, set);
      return organizationMemberResponse(member);
    },
    async update(invocation) {
      const organizationId = invocation.scope.organizationId;
      const principalId = invocation.id;
      const item = get(
        state.organizationMembers,
        organizationId && principalId ? `${organizationId}:${principalId}` : undefined,
        "Organization member",
      );
      const next = updateRecord(item, { role: invocation.body.role });
      state.organizationMembers.set(`${item.organizationId}:${item.principalId}`, next);
      return organizationMemberResponse(next);
    },
    async remove(invocation) {
      const organizationId = invocation.scope.organizationId;
      const principalId = invocation.id;
      const item = get(
        state.organizationMembers,
        organizationId && principalId ? `${organizationId}:${principalId}` : undefined,
        "Organization member",
      );
      const next = updateRecord(item, { removedAt: now(), status: "removed" });
      state.organizationMembers.set(`${item.organizationId}:${item.principalId}`, next);
      memberships.get(item.principalId)?.delete(item.organizationId);
      return organizationMemberResponse(next);
    },
  };

  const publicInvitation = (item: OrganizationInvitationRecord) => {
    const { token: _token, ...response } = item;
    return organizationInvitationResponse(response);
  };

  const organizationInvitations: TenancyApiService["organizationInvitations"] = {
    async list(invocation) {
      return page(
        [...state.organizationInvitations.values()]
          .filter(
            (item) =>
              item.organizationId === invocation.scope.organizationId && item.status === "pending",
          )
          .map(publicInvitation),
        invocation.query,
      );
    },
    async create(invocation) {
      const organizationId = invocation.scope.organizationId;
      if (!organizationId)
        throw new ApiProblem(400, "missing_scope", "The organization scope is required.");
      const invitationId = id();
      const token = `dpl_inv_${invitationId}_${randomBytes(24).toString("base64url")}`;
      const item: OrganizationInvitationRecord = createRecord({
        email: invocation.body.email,
        expiresAt:
          invocation.body.expiresAt ??
          new Date(Date.parse(now()) + 7 * 24 * 60 * 60_000).toISOString(),
        id: invitationId,
        invitedByPrincipalId: invocation.identity.principalId,
        organizationId,
        role: invocation.body.role,
        status: "pending",
        token,
      });
      state.organizationInvitations.set(item.id, item);
      return { ...publicInvitation(item), secretVisibleOnce: true, token };
    },
    async revoke(invocation) {
      const item = get(state.organizationInvitations, invocation.id, "Organization invitation");
      assertScope({ organizationId: item.organizationId }, invocation);
      const next = updateRecord(item, { revokedAt: now(), status: "revoked" });
      state.organizationInvitations.set(item.id, next);
      return publicInvitation(next);
    },
    async accept(invocation) {
      const item = get(state.organizationInvitations, invocation.id, "Organization invitation");
      if (item.token !== invocation.body.token) {
        throw new ApiProblem(403, "invalid_invitation_token", "The invitation token is invalid.");
      }
      const principalId = invocation.identity.principalId;
      const member: OrganizationMemberRecord = createRecord({
        id: principalId,
        joinedAt: now(),
        organizationId: item.organizationId,
        principalId,
        role: item.role,
        status: "active",
      });
      state.organizationMembers.set(`${item.organizationId}:${principalId}`, member);
      state.organizationInvitations.set(
        item.id,
        updateRecord(item, {
          acceptedAt: now(),
          acceptedByPrincipalId: principalId,
          status: "accepted",
        }),
      );
      const set = memberships.get(principalId) ?? new Set();
      set.add(item.organizationId);
      memberships.set(principalId, set);
      return organizationMemberResponse(member);
    },
  };

  const projects: TenancyApiService["projects"] = {
    async list(invocation) {
      return page(
        [...state.projects.values()]
          .filter((item) => item.organizationId === invocation.scope.organizationId)
          .map(projectResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const organizationId = invocation.scope.organizationId;
      if (!organizationId)
        throw new ApiProblem(400, "missing_scope", "The organization scope is required.");
      get(state.organizations, organizationId, "Organization");
      const body = invocation.body;
      const slug = String(
        resolveSlug({
          name: body.name,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        }),
      );
      unique(
        state.projects,
        (item) => item.organizationId === organizationId && item.slug === slug,
        "Project slug",
      );
      const item: ProjectRecord = createRecord({
        id: id(),
        organizationId,
        name: body.name,
        slug,
        status: "active",
      });
      state.projects.set(item.id, item);
      return projectResponse(item);
    },
    async get(invocation) {
      const item = get(state.projects, invocation.id, "Project");
      assertScope({ projectId: item.id }, invocation);
      return projectResponse(item);
    },
    async update(invocation) {
      const item = get(state.projects, invocation.id, "Project");
      assertScope({ projectId: item.id }, invocation);
      const body = invocation.body;
      const slug = body.slug
        ? String(resolveSlug({ name: body.name ?? item.name, slug: body.slug }))
        : item.slug;
      unique(
        state.projects,
        (entry) => entry.organizationId === item.organizationId && entry.slug === slug,
        "Project slug",
        item.id,
      );
      const next = updateRecord(item, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        slug,
      });
      state.projects.set(item.id, next);
      return projectResponse(next);
    },
    async archive(invocation) {
      const item = get(state.projects, invocation.id, "Project");
      assertScope({ projectId: item.id }, invocation);
      const next = updateRecord(item, { status: "archived" });
      state.projects.set(item.id, next);
      return projectResponse(next);
    },
  };

  const environments: TenancyApiService["environments"] = {
    async list(invocation) {
      return page(
        [...state.environments.values()]
          .filter((item) => item.projectId === invocation.scope.projectId)
          .map(environmentResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const project = get(state.projects, invocation.scope.projectId, "Project");
      const body = invocation.body;
      const slug = String(
        resolveSlug({
          name: body.name,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        }),
      );
      unique(
        state.environments,
        (item) => item.projectId === project.id && item.slug === slug,
        "Environment slug",
      );
      const item: EnvironmentRecord = createRecord({
        id: id(),
        organizationId: project.organizationId,
        projectId: project.id,
        name: body.name,
        slug,
        kind: body.type,
        status: "active",
      });
      state.environments.set(item.id, item);
      return environmentResponse(item);
    },
    async get(invocation) {
      const item = get(state.environments, invocation.id, "Environment");
      assertScope({ environmentId: item.id }, invocation);
      return environmentResponse(item);
    },
    async update(invocation) {
      const item = get(state.environments, invocation.id, "Environment");
      assertScope({ environmentId: item.id }, invocation);
      const body = invocation.body;
      const slug = body.slug
        ? String(resolveSlug({ name: body.name ?? item.name, slug: body.slug }))
        : item.slug;
      unique(
        state.environments,
        (entry) => entry.projectId === item.projectId && entry.slug === slug,
        "Environment slug",
        item.id,
      );
      const next = updateRecord(item, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        slug,
      });
      state.environments.set(item.id, next);
      return environmentResponse(next);
    },
    async archive(invocation) {
      const item = get(state.environments, invocation.id, "Environment");
      assertScope({ environmentId: item.id }, invocation);
      const next = updateRecord(item, { status: "archived" });
      state.environments.set(item.id, next);
      return environmentResponse(next);
    },
  };

  const workspaces: TenancyApiService["workspaces"] = {
    async list(invocation) {
      return page(
        [...state.workspaces.values()]
          .filter((item) => item.environmentId === invocation.scope.environmentId)
          .map(workspaceResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const environment = environmentFor(invocation);
      const body = invocation.body;
      const workspaceSlug = String(
        resolveSlug({
          name: body.name,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        }),
      );
      unique(
        state.workspaces,
        (item) => item.environmentId === environment.id && item.slug === workspaceSlug,
        "Workspace slug",
      );
      const item: WorkspaceRecord = createRecord({
        createdByPrincipalId: invocation.identity.principalId,
        ...(body.description ? { description: body.description } : {}),
        environmentId: environment.id,
        id: id(),
        name: body.name,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        slug: workspaceSlug,
        status: "active",
      });
      state.workspaces.set(item.id, item);
      return workspaceResponse(item);
    },
    async get(invocation) {
      const item = get(state.workspaces, invocation.id, "Workspace");
      assertScope({ environmentId: item.environmentId }, invocation);
      return workspaceResponse(item);
    },
    async update(invocation) {
      const item = get(state.workspaces, invocation.id, "Workspace");
      assertScope({ environmentId: item.environmentId }, invocation);
      const body = invocation.body;
      const workspaceSlug = body.slug
        ? String(resolveSlug({ name: body.name ?? item.name, slug: body.slug }))
        : item.slug;
      unique(
        state.workspaces,
        (entry) => entry.environmentId === item.environmentId && entry.slug === workspaceSlug,
        "Workspace slug",
        item.id,
      );
      const base =
        body.description === null ? (({ description: _description, ...rest }) => rest)(item) : item;
      const next = updateRecord(base as WorkspaceRecord, {
        ...(body.description !== null && body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        slug: workspaceSlug,
      });
      state.workspaces.set(item.id, next);
      return workspaceResponse(next);
    },
    async archive(invocation) {
      const item = get(state.workspaces, invocation.id, "Workspace");
      assertScope({ environmentId: item.environmentId }, invocation);
      const next = updateRecord(item, { status: "archived" });
      state.workspaces.set(item.id, next);
      return workspaceResponse(next);
    },
  };

  const serviceAccounts: TenancyApiService["serviceAccounts"] = {
    async list(invocation) {
      return page(
        [...state.serviceAccounts.values()]
          .filter((item) => item.environmentId === invocation.scope.environmentId)
          .map(serviceAccountResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const environment = [...state.environments.values()].find(
        (item) => item.id === invocation.scope.environmentId,
      );
      if (!environment)
        throw new ApiProblem(404, "resource_not_found", "Environment was not found.");
      const body = invocation.body;
      const item: ServiceAccountRecord = createRecord({
        id: id(),
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        createdByPrincipalId: invocation.identity.principalId,
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        scopes: body.scopes,
        status: "active",
      });
      state.serviceAccounts.set(item.id, item);
      return serviceAccountResponse(item);
    },
    async get(invocation) {
      const item = get(state.serviceAccounts, invocation.id, "Service account");
      assertScope({ environmentId: item.environmentId }, invocation);
      return serviceAccountResponse(item);
    },
    async revoke(invocation) {
      const item = get(state.serviceAccounts, invocation.id, "Service account");
      assertScope({ environmentId: item.environmentId }, invocation);
      const next = updateRecord(item, { status: "disabled" });
      state.serviceAccounts.set(item.id, next);
      return serviceAccountResponse(next);
    },
  };

  const apiCredentials: TenancyApiService["apiCredentials"] = {
    async list(invocation) {
      return page(
        [...state.apiCredentials.values()]
          .filter((item) => item.environmentId === invocation.scope.environmentId)
          .map(apiCredentialResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const body = invocation.body;
      const account = get(state.serviceAccounts, body.serviceAccountId, "Service account");
      assertScope({ environmentId: account.environmentId }, invocation);
      if (account.status !== "active")
        throw new ApiProblem(409, "service_account_disabled", "The service account is disabled.");
      const requested = body.scopes ?? account.scopes;
      if (
        requested.some(
          (value) => !account.scopes.includes(value) && !account.scopes.includes("platform:*"),
        )
      )
        throw new ApiProblem(
          422,
          "invalid_scope",
          "API-key scopes must be a subset of service-account scopes.",
        );
      const secret = `dpl_${id()}_${randomBytes(24).toString("base64url")}`;
      const item: ApiCredentialRecord = createRecord({
        id: id(),
        organizationId: account.organizationId,
        projectId: account.projectId,
        environmentId: account.environmentId,
        serviceAccountId: account.id,
        name: body.name,
        scopes: requested,
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
        keyPrefix: secret.slice(0, 16),
        credentialHash: createHash("sha256").update(secret).digest("hex"),
        status: "active",
      });
      state.apiCredentials.set(item.id, item);
      state.secrets.set(secret, item.id);
      return issuedApiCredentialResponse(item, secret);
    },
    async rotate(invocation) {
      const item = get(state.apiCredentials, invocation.id, "API credential");
      assertScope({ environmentId: item.environmentId }, invocation);
      for (const [secret, credentialId] of state.secrets)
        if (credentialId === item.id) state.secrets.delete(secret);
      const secret = `dpl_${id()}_${randomBytes(24).toString("base64url")}`;
      const next = updateRecord(item, {
        keyPrefix: secret.slice(0, 16),
        credentialHash: createHash("sha256").update(secret).digest("hex"),
      });
      state.apiCredentials.set(item.id, next);
      state.secrets.set(secret, item.id);
      return issuedApiCredentialResponse(next, secret);
    },
    async revoke(invocation) {
      const item = get(state.apiCredentials, invocation.id, "API credential");
      assertScope({ environmentId: item.environmentId }, invocation);
      for (const [secret, credentialId] of state.secrets)
        if (credentialId === item.id) state.secrets.delete(secret);
      const next = updateRecord(item, { status: "revoked", revokedAt: now() });
      state.apiCredentials.set(item.id, next);
      return apiCredentialResponse(next);
    },
  };
  return {
    organizations,
    organizationMembers,
    organizationInvitations,
    projects,
    environments,
    workspaces,
    serviceAccounts,
    apiCredentials,
  };
}
