import { type AgentDeploymentConfigV1, type AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  ApiProblem,
  createTenancyApi,
  type ApiIdentity,
  type ApiInvocation,
  type IdempotencyStore,
  type TenancyApiService,
} from "@deployments-ai/api";
import { monotonicFactory } from "ulid";
import { makeAgentFixtureServices } from "./agent-fixture-services.ts";
import { makeTenancyFixtureServices } from "./tenancy-fixture-services.ts";

export interface MutableFields {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface OrganizationRecord extends MutableFields, Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "archived";
}

export interface ProjectRecord extends MutableFields, Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly status: "active" | "archived";
}

export interface EnvironmentRecord extends MutableFields, Record<string, unknown> {
  readonly id: string;
  readonly kind: "custom" | "development" | "production" | "staging";
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly status: "active" | "archived";
}

export interface WorkspaceRecord extends MutableFields, Record<string, unknown> {
  readonly createdByPrincipalId: string;
  readonly description?: string;
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly status: "active" | "archived";
}

export interface OrganizationMemberRecord extends MutableFields, Record<string, unknown> {
  readonly id: string;
  readonly joinedAt?: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly removedAt?: string;
  readonly role: "admin" | "billing" | "member" | "owner" | "viewer";
  readonly status: "active" | "invited" | "removed";
}

export interface OrganizationInvitationRecord extends MutableFields, Record<string, unknown> {
  readonly acceptedAt?: string;
  readonly acceptedByPrincipalId?: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly invitedByPrincipalId: string;
  readonly organizationId: string;
  readonly revokedAt?: string;
  readonly role: "admin" | "billing" | "member" | "owner" | "viewer";
  readonly status: "accepted" | "expired" | "pending" | "revoked";
  readonly token: string;
}

export interface ServiceAccountRecord extends MutableFields, Record<string, unknown> {
  readonly createdByPrincipalId: string;
  readonly description?: string;
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly status: "active" | "disabled";
}

export interface ApiCredentialRecord extends MutableFields, Record<string, unknown> {
  readonly credentialHash: string;
  readonly environmentId: string;
  readonly expiresAt?: string;
  readonly id: string;
  readonly keyPrefix: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly revokedAt?: string;
  readonly scopes: readonly string[];
  readonly serviceAccountId: string;
  readonly status: "active" | "expired" | "revoked";
}

export interface AgentDefinitionRecord extends MutableFields, Record<string, unknown> {
  readonly draft: AgentManifestV1;
  readonly environmentId: string;
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly slug: string;
  readonly status: "active" | "archived";
}

export interface AgentReleaseRecord extends Record<string, unknown> {
  readonly agentDefinitionId: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly environmentId: string;
  readonly id: string;
  readonly manifest: AgentManifestV1;
  readonly organizationId: string;
  readonly projectId: string;
  readonly releaseNumber: number;
  readonly status: "active" | "archived";
  readonly version: number;
}

export interface AgentDeploymentRecord extends MutableFields, Record<string, unknown> {
  readonly agentDefinitionId: string;
  readonly agentReleaseId: string;
  readonly currentState: "deploying" | "failed" | "paused" | "ready" | "stopped";
  readonly desiredState: "paused" | "running" | "stopped";
  readonly environmentId: string;
  readonly id: string;
  readonly lastTransitionAt?: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runtimeConfig?: AgentDeploymentConfigV1;
}
export function makeTenancyFixtureContext(options: { readonly now?: string } = {}) {
  const now = () => options.now ?? "2026-07-22T00:00:00.000Z";
  const id = monotonicFactory(() => Date.parse(now()));
  const state = {
    agentDefinitions: new Map<string, AgentDefinitionRecord>(),
    agentDeployments: new Map<string, AgentDeploymentRecord>(),
    agentReleases: new Map<string, AgentReleaseRecord>(),
    organizations: new Map<string, OrganizationRecord>(),
    projects: new Map<string, ProjectRecord>(),
    environments: new Map<string, EnvironmentRecord>(),
    workspaces: new Map<string, WorkspaceRecord>(),
    organizationMembers: new Map<string, OrganizationMemberRecord>(),
    organizationInvitations: new Map<string, OrganizationInvitationRecord>(),
    serviceAccounts: new Map<string, ServiceAccountRecord>(),
    apiCredentials: new Map<string, ApiCredentialRecord>(),
    secrets: new Map<string, string>(),
  };
  const memberships = new Map<string, Set<string>>();
  const idempotencyValues = new Map<string, { fingerprint: string; value: unknown }>();
  const adminToken = "fixture_admin_token";
  const adminPrincipalId = id();

  const identityFor = (token: string): ApiIdentity | null => {
    if (token === adminToken)
      return {
        principalId: adminPrincipalId,
        scopes: ["platform:*"],
        organizationIds: "*",
        projectIds: "*",
        environmentIds: "*",
      };
    const credentialId = state.secrets.get(token);
    const credential = credentialId ? state.apiCredentials.get(credentialId) : undefined;
    if (
      !credential ||
      credential.status !== "active" ||
      (credential.expiresAt && credential.expiresAt <= now())
    )
      return null;
    const account = state.serviceAccounts.get(credential.serviceAccountId);
    if (!account || account.status !== "active") return null;
    return {
      principalId: account.id,
      scopes: credential.scopes,
      organizationIds: [credential.organizationId],
      projectIds: [credential.projectId],
      environmentIds: [credential.environmentId],
    };
  };

  const page = <Item>(items: readonly Item[], query: ApiInvocation["query"]) => {
    const offset = query.cursor
      ? Number(Buffer.from(query.cursor, "base64url").toString("utf8"))
      : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new ApiProblem(400, "invalid_cursor", "The pagination cursor is invalid.");
    const limit = query.limit ?? 50;
    const selected = items.slice(offset, offset + limit);
    return {
      items: selected,
      nextCursor:
        offset + selected.length < items.length
          ? Buffer.from(String(offset + selected.length)).toString("base64url")
          : null,
    };
  };
  const createRecord = <Data extends Record<string, unknown>>(
    data: Data,
  ): Data & MutableFields & Record<string, unknown> => ({
    ...data,
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  });
  const createAgentRecord = <Data extends Record<string, unknown>>(
    data: Data,
  ): Data & MutableFields & Record<string, unknown> => ({
    ...createRecord(data),
    version: 0,
  });
  const get = <Item>(map: Map<string, Item>, key: string | undefined, type: string): Item => {
    const value = key ? map.get(key) : undefined;
    if (!value) throw new ApiProblem(404, "resource_not_found", `${type} was not found.`);
    return value;
  };
  const unique = <Item extends { readonly id: string }>(
    map: Map<string, Item>,
    predicate: (item: Item) => boolean,
    label: string,
    except?: string,
  ) => {
    if ([...map.values()].some((item) => item.id !== except && predicate(item)))
      throw new ApiProblem(409, "resource_conflict", `${label} is already in use.`);
  };
  const updateRecord = <Item extends MutableFields>(item: Item, fields: Partial<Item>): Item => ({
    ...item,
    ...fields,
    updatedAt: now(),
    version: item.version + 1,
  });
  const assertScope = (expected: ApiInvocation["scope"], invocation: ApiInvocation) => {
    const keys = ["organizationId", "projectId", "environmentId"] as const;
    for (const key of keys) {
      const requested = invocation.scope[key];
      if (requested !== undefined && expected[key] !== requested) {
        throw new ApiProblem(
          403,
          `${key.replace("Id", "")}_scope_violation`,
          "The resource is outside the requested scope.",
        );
      }
    }
  };
  const expectedVersion = (actual: number, expected: number) => {
    if (actual !== expected) {
      throw new ApiProblem(409, "version_conflict", "The resource version has changed.");
    }
  };
  const environmentFor = (invocation: ApiInvocation) => {
    const environment = [...state.environments.values()].find(
      (item) => item.id === invocation.scope.environmentId,
    );
    if (!environment) {
      throw new ApiProblem(404, "resource_not_found", "Environment was not found.");
    }
    return environment;
  };
  return {
    now,
    id,
    state,
    memberships,
    idempotencyValues,
    adminToken,
    adminPrincipalId,
    identityFor,
    page,
    createRecord,
    createAgentRecord,
    get,
    unique,
    updateRecord,
    assertScope,
    expectedVersion,
    environmentFor,
  };
}

export type TenancyFixtureContext = ReturnType<typeof makeTenancyFixtureContext>;

export function createTenancyContractFixture(
  options: {
    readonly authorize?: (
      invocation: ApiInvocation,
      operationName: string,
      mutation: boolean,
    ) => Promise<void>;
    readonly now?: string;
  } = {},
) {
  const context = makeTenancyFixtureContext(options);
  const { state, idempotencyValues, adminToken, identityFor } = context;
  const {
    organizations,
    organizationMembers,
    organizationInvitations,
    projects,
    environments,
    workspaces,
    serviceAccounts,
    apiCredentials,
  } = makeTenancyFixtureServices(context);
  const { agentDefinitions, agentReleases, agentDeployments } = makeAgentFixtureServices(context);

  const service: TenancyApiService = {
    agentDefinitions,
    agentDeployments,
    agentReleases,
    organizations,
    organizationMembers,
    organizationInvitations,
    projects,
    environments,
    workspaces,
    serviceAccounts,
    apiCredentials,
  };

  const idempotency: IdempotencyStore = {
    async execute(input) {
      const key = `${input.principalId}:${input.key}`;
      const prior = idempotencyValues.get(key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint)
          throw new ApiProblem(
            409,
            "idempotency_conflict",
            "The idempotency key was already used for a different request.",
          );
        return structuredClone(prior.value);
      }
      const value = await input.operation();
      idempotencyValues.set(key, { fingerprint: input.fingerprint, value: structuredClone(value) });
      return value;
    },
  };
  const fetch = createTenancyApi({
    authorize: options.authorize ?? (async () => undefined),
    authenticate: async (request) => {
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
      return token ? identityFor(token) : null;
    },
    idempotency,
    requestId: (() => {
      let sequence = 0;
      return () => `req_fixture_${++sequence}`;
    })(),
    service,
  });
  return { adminToken, fetch, state };
}
