import type {
  AgentDeploymentConfigV1,
  AgentManifestV1,
} from "@deployments-ai/agent-manifest/schema";
import { agentDeploymentConfigSemanticIssues } from "@deployments-ai/agent-manifest/semantics";
import {
  TENANCY_API_ROUTES,
  tenancyRouteContract,
  type TenancyRouteName,
} from "@deployments-ai/api-contract/routes";
import {
  decodeTenancyIdempotencyKey,
  decodeTenancyQuery,
  decodeTenancyRequest,
  decodeTenancyResponse,
} from "@deployments-ai/api-contract/validation";
import type { PlatformRequest } from "./index.ts";

import {
  agentDefinition,
  agentRelease,
  agentScope,
  body,
  canonicalValue,
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  type MockListQuery,
  optionalString,
  publicId,
  scope,
  type StoredAgentDefinition,
  type StoredAgentDeployment,
  type StoredAgentRelease,
  type StoredManagedSkillSource,
  type StoredWorkflowDefinition,
  type StoredWorkflowRelease,
  targetId,
  TENANCY_PATH_PREFIXES,
  type TenancyMockResult,
  tenancyMockRouteHandlers,
  type TenancyMockState,
  validateRouteScope,
} from "./tenancy-mock-state.ts";
export function agentDeployment(
  request: PlatformRequest,
  now: string,
  id: string,
  agentDefinitionId: string = MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
  agentReleaseId: string = MOCK_TENANCY_FIXTURE_IDS.agentRelease,
) {
  const input = body(request);
  const stopped = request.method === "DELETE";
  const desiredState = stopped ? "stopped" : (optionalString(input.desiredState) ?? "running");
  return {
    createdAt: now,
    ...agentScope(request),
    agentDefinitionId,
    agentReleaseId: publicId(input.agentReleaseId, agentReleaseId, "agentReleaseId"),
    currentState: desiredState === "running" ? "ready" : desiredState,
    desiredState,
    id: publicId(id, MOCK_TENANCY_FIXTURE_IDS.agentDeployment, "agentDeploymentId"),
    lastTransitionAt: now,
    ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
    updatedAt: now,
    version: 0,
  };
}

export function fixtureAgentRequest(request: PlatformRequest): PlatformRequest {
  return {
    context: MOCK_TENANCY_CONTEXT,
    method: "GET",
    path: request.path,
  };
}

function assertAgentEnvironmentScope(
  item: Readonly<Record<string, unknown>>,
  request: PlatformRequest,
) {
  if (item.environmentId !== scope(request).environmentId) {
    throw new TypeError("Agent resource was not found in the requested environment.");
  }
}

export function requireAgentDefinition(
  state: TenancyMockState,
  request: PlatformRequest,
  now: string,
  id: string,
): StoredAgentDefinition {
  const stored = state.agentDefinitions.get(id);
  if (stored) {
    assertAgentEnvironmentScope(stored, request);
    return stored;
  }
  if (id !== MOCK_TENANCY_FIXTURE_IDS.agentDefinition) {
    throw new TypeError("Agent definition was not found.");
  }
  const fixture = agentDefinition(fixtureAgentRequest(request), now, id) as StoredAgentDefinition;
  assertAgentEnvironmentScope(fixture, request);
  return fixture;
}

export function requireAgentRelease(
  state: TenancyMockState,
  request: PlatformRequest,
  now: string,
  id: string,
): StoredAgentRelease {
  const stored = state.agentReleases.get(id);
  if (stored) {
    assertAgentEnvironmentScope(stored, request);
    return stored;
  }
  if (id !== MOCK_TENANCY_FIXTURE_IDS.agentRelease) {
    throw new TypeError("Agent release was not found.");
  }
  const fixture = agentRelease(fixtureAgentRequest(request), now, id) as StoredAgentRelease;
  assertAgentEnvironmentScope(fixture, request);
  return fixture;
}

export function requireAgentDeployment(
  state: TenancyMockState,
  request: PlatformRequest,
  now: string,
  id: string,
): StoredAgentDeployment {
  const stored = state.agentDeployments.get(id);
  if (stored) {
    assertAgentEnvironmentScope(stored, request);
    return stored;
  }
  if (id !== MOCK_TENANCY_FIXTURE_IDS.agentDeployment) {
    throw new TypeError("Agent deployment was not found.");
  }
  const fixture = agentDeployment(fixtureAgentRequest(request), now, id) as StoredAgentDeployment;
  assertAgentEnvironmentScope(fixture, request);
  return fixture;
}

function defaultWorkflowDefinition() {
  return {
    entryStepId: "done",
    name: "Mock workflow",
    schemaVersion: 1,
    slug: "mock-workflow",
    steps: [{ id: "done", type: "end" }],
  } as const;
}

export function workflowDefinition(
  request: PlatformRequest,
  now: string,
  id: string,
): StoredWorkflowDefinition {
  const input = body(request);
  const draft =
    input.definition && typeof input.definition === "object"
      ? input.definition
      : defaultWorkflowDefinition();
  const document = draft as Readonly<Record<string, unknown>>;
  return {
    createdAt: now,
    ...agentScope(request),
    draft,
    id: publicId(id, id, "workflowDefinitionId"),
    name: document.name,
    slug: document.slug,
    status: "active",
    updatedAt: now,
    version: 0,
  };
}

export function workflowDefinitionSummary(record: StoredWorkflowDefinition) {
  const { draft: _, ...summary } = record;
  return summary;
}

export function requireWorkflowDefinition(
  state: TenancyMockState,
  request: PlatformRequest,
  id: string,
) {
  const record = state.workflowDefinitions.get(id);
  if (!record) throw new TypeError("Workflow definition was not found.");
  assertAgentEnvironmentScope(record, request);
  return record;
}

export function workflowReleaseSummary(record: StoredWorkflowRelease) {
  const { definition: _, ...summary } = record;
  return summary;
}

export function requireWorkflowRelease(
  state: TenancyMockState,
  request: PlatformRequest,
  id: string,
) {
  const record = state.workflowReleases.get(id);
  if (!record) throw new TypeError("Workflow release was not found.");
  assertAgentEnvironmentScope(record, request);
  return record;
}

export function managedSkillSource(
  request: PlatformRequest,
  now: string,
  id: string,
): StoredManagedSkillSource {
  const input = body(request);
  return {
    createdAt: now,
    id: publicId(id, id, "managedSkillSourceId"),
    key: input.key,
    ...(input.licenseHash ? { licenseHash: input.licenseHash } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    name: input.name,
    ...(input.pinnedCommit ? { pinnedCommit: input.pinnedCommit } : {}),
    ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
    status: "active",
    updatedAt: now,
    version: 0,
  } as StoredManagedSkillSource;
}

export function requireManagedSkillSource(state: TenancyMockState, id: string) {
  const record = state.managedSkillSources.get(id);
  if (!record) throw new TypeError("Managed skill source was not found.");
  return record;
}

export function requireManagedSkillRelease(state: TenancyMockState, id: string) {
  const record = state.managedSkillReleases.get(id);
  if (!record) throw new TypeError("Managed skill release was not found.");
  return record;
}

export function requireManagedSkill(state: TenancyMockState, id: string) {
  const record = state.managedSkills.get(id);
  if (!record) throw new TypeError("Managed skill was not found.");
  return record;
}

export function requireManagedSkillInstallation(
  state: TenancyMockState,
  request: PlatformRequest,
  id: string,
) {
  const record = state.managedSkillInstallations.get(id);
  if (!record) throw new TypeError("Managed skill installation was not found.");
  assertAgentEnvironmentScope(record, request);
  return record;
}

export function assertActive(record: Readonly<Record<string, unknown>>, label: string) {
  if (record.status !== "active") throw new TypeError(`${label} is not active.`);
}

export function assertDeploymentConfig(manifest: unknown, config: unknown) {
  const issues = agentDeploymentConfigSemanticIssues(
    config as AgentDeploymentConfigV1,
    manifest as AgentManifestV1,
  );
  if (issues.length > 0) {
    throw new TypeError(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }
}

function response(routeName: TenancyRouteName, data: unknown): TenancyMockResult {
  return { data: decodeTenancyResponse(routeName, data), matched: true };
}

function pathMatches(template: string, path: string) {
  const templateSegments = template.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  return (
    templateSegments.length === pathSegments.length &&
    templateSegments.every((segment, index) => segment === ":id" || segment === pathSegments[index])
  );
}

function matchedRoute(
  request: PlatformRequest,
):
  | { readonly error: string }
  | { readonly name: TenancyRouteName; readonly path: string }
  | undefined {
  const pathRoutes = TENANCY_API_ROUTES.filter((route) => pathMatches(route.path, request.path));
  if (pathRoutes.length === 0) {
    const tenancyNamespace = TENANCY_PATH_PREFIXES.find(
      (prefix) => request.path === prefix || request.path.startsWith(`${prefix}/`),
    );
    return tenancyNamespace ? { error: `Unsupported tenancy path ${request.path}.` } : undefined;
  }
  const route = pathRoutes.find((candidate) => candidate.method === request.method);
  return route
    ? { name: route.name, path: route.path }
    : { error: `${request.method} is not supported for tenancy path ${request.path}.` };
}
export interface TenancyMockRouteContext {
  readonly id: string | undefined;
  readonly inputRequest: PlatformRequest;
  readonly issued: boolean;
  readonly listQuery: MockListQuery;
  readonly now: string;
  readonly request: PlatformRequest;
  readonly respond: (data: unknown) => TenancyMockResult;
  readonly routeName: TenancyRouteName;
  readonly state: TenancyMockState;
}

export async function mockTenancyData(
  inputRequest: PlatformRequest,
  now: string,
  state: TenancyMockState,
): Promise<TenancyMockResult> {
  const match = matchedRoute(inputRequest);
  if (!match) return { matched: false };
  if ("error" in match) return { error: match.error, matched: true };
  const routeName = match.name;
  const id = match.path.includes(":id") ? targetId(inputRequest.path, match.path) : undefined;
  const issued = routeName === "createApiCredential" || routeName === "rotateApiCredential";
  try {
    const route = tenancyRouteContract(routeName);
    validateRouteScope(route.scope, inputRequest);
    const listQuery =
      route.method === "GET" && route.name.startsWith("list")
        ? (decodeTenancyQuery(routeName, inputRequest.query) as MockListQuery)
        : {};
    if (route.idempotent) {
      decodeTenancyIdempotencyKey(routeName, inputRequest.idempotencyKey);
    }
    if (!route.requestBody && inputRequest.body !== undefined) {
      throw new TypeError(`Route ${routeName} does not accept a request body.`);
    }
    const request = route.requestBody
      ? { ...inputRequest, body: decodeTenancyRequest(routeName, inputRequest.body) }
      : inputRequest;
    const idempotency = route.idempotent
      ? {
          fingerprint: JSON.stringify(
            canonicalValue({
              body: request.body ?? null,
              context: request.context ?? null,
              method: request.method,
              path: request.path,
              query: request.query ?? null,
            }),
          ),
          key: request.idempotencyKey!,
        }
      : undefined;
    const priorIdempotency = idempotency
      ? state.idempotencyResults.get(idempotency.key)
      : undefined;
    if (priorIdempotency) {
      if (priorIdempotency.fingerprint !== idempotency!.fingerprint) {
        throw new TypeError("The idempotency key was already used for a different request.");
      }
      return { data: structuredClone(priorIdempotency.data), matched: true };
    }
    const respond = (data: unknown): TenancyMockResult => {
      const result = response(routeName, data);
      if (idempotency && "data" in result) {
        state.idempotencyResults.set(idempotency.key, {
          data: structuredClone(result.data),
          fingerprint: idempotency.fingerprint,
        });
      }
      return result;
    };
    const context: TenancyMockRouteContext = {
      id,
      inputRequest,
      issued,
      listQuery,
      now,
      request,
      respond,
      routeName,
      state,
    };
    for (const handleRoutes of tenancyMockRouteHandlers) {
      const result = await handleRoutes(context);
      if (result) return result;
    }
    return { error: "Mock tenancy route " + routeName + " is not implemented.", matched: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid tenancy mock request.",
      matched: true,
    };
  }
}
