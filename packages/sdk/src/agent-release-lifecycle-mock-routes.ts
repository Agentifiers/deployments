import type {
  StoredAgentDefinition,
  StoredAgentDeployment,
  StoredAgentRelease,
  TenancyMockResult,
  TenancyMockRouteContext,
} from "./tenancy-mock.ts";
import {
  MOCK_TENANCY_FIXTURE_IDS,
  agentDefinition,
  agentRelease,
  agentScope,
  assertExpectedVersion,
  body,
  nextPublicId,
  publicId,
  requireAgentDefinition,
  requireAgentDeployment,
  requireAgentRelease,
} from "./tenancy-mock.ts";

type RouteContext = TenancyMockRouteContext;

export async function handleAgentReleaseLifecycleMockRoutes(
  context: RouteContext,
): Promise<TenancyMockResult | undefined> {
  switch (context.routeName) {
    case "startAgentDeploymentCanary":
      return startCanary(context);
    case "promoteAgentDeploymentCanary":
      return resolveCanary(context, true);
    case "abortAgentDeploymentCanary":
      return resolveCanary(context, false);
    case "promoteAgentRelease":
      return promoteRelease(context);
    default:
      return undefined;
  }
}

/** Resolves the release a deployment is being retargeted to, enforcing same-definition and canary rules. */
export function requireRetargetRelease(
  context: RouteContext,
  prior: StoredAgentDeployment,
  agentReleaseId: string,
): StoredAgentRelease {
  if (prior.candidateAgentReleaseId !== undefined) {
    throw new TypeError("canary_active: Resolve the active canary before retargeting.");
  }
  return requireSameDefinitionRelease(context, prior, agentReleaseId);
}

function requireSameDefinitionRelease(
  { now, request, state }: RouteContext,
  deployment: StoredAgentDeployment,
  agentReleaseId: string,
): StoredAgentRelease {
  const release = requireAgentRelease(state, request, now, agentReleaseId);
  if (release.agentDefinitionId !== deployment.agentDefinitionId) {
    throw new TypeError("Release belongs to a different agent definition.");
  }
  if (release.status === "archived") {
    throw new TypeError("Archived releases cannot be deployed.");
  }
  return release;
}

function withoutCandidate(deployment: StoredAgentDeployment): StoredAgentDeployment {
  const {
    candidateAgentReleaseId: _release,
    candidateStartedAt: _started,
    candidateWeight: _weight,
    ...rest
  } = deployment;
  return rest as StoredAgentDeployment;
}

function activeDeployment(context: RouteContext): StoredAgentDeployment {
  const { id, now, request, state } = context;
  const deploymentId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDeployment;
  const prior = requireAgentDeployment(state, request, now, deploymentId);
  assertExpectedVersion(prior.version, body(request).expectedVersion);
  if (prior.desiredState === "stopped") {
    throw new TypeError("Stopped deployments cannot be updated.");
  }
  return prior;
}

function save(context: RouteContext, item: StoredAgentDeployment): TenancyMockResult {
  context.state.agentDeployments.set(item.id, item);
  return context.respond(item);
}

function startCanary(context: RouteContext): TenancyMockResult {
  const prior = activeDeployment(context);
  const input = body(context.request);
  if (prior.candidateAgentReleaseId !== undefined) {
    throw new TypeError("canary_active: A canary is already active.");
  }
  const candidateId = publicId(
    input.candidateAgentReleaseId,
    MOCK_TENANCY_FIXTURE_IDS.agentRelease,
    "candidateAgentReleaseId",
  );
  if (candidateId === prior.agentReleaseId) {
    throw new TypeError("Candidate release must differ from the primary release.");
  }
  requireSameDefinitionRelease(context, prior, candidateId);
  return save(context, {
    ...prior,
    candidateAgentReleaseId: candidateId,
    candidateStartedAt: context.now,
    candidateWeight: Number(input.weight),
    updatedAt: context.now,
    version: prior.version + 1,
  });
}

function resolveCanary(context: RouteContext, promote: boolean): TenancyMockResult {
  const prior = activeDeployment(context);
  const candidateId = prior.candidateAgentReleaseId;
  if (typeof candidateId !== "string") {
    throw new TypeError("canary_not_active: The deployment has no active canary.");
  }
  return save(context, {
    ...withoutCandidate(prior),
    ...(promote ? { agentReleaseId: candidateId } : {}),
    updatedAt: context.now,
    version: prior.version + 1,
  });
}

async function promoteRelease(context: RouteContext): Promise<TenancyMockResult> {
  const { id, now, request, state } = context;
  const source = requireAgentRelease(
    state,
    request,
    now,
    id ?? MOCK_TENANCY_FIXTURE_IDS.agentRelease,
  );
  const sourceDefinition = requireAgentDefinition(state, request, now, source.agentDefinitionId);
  if (sourceDefinition.workspaceId !== undefined) {
    throw new TypeError(
      "workspace_scoped_definition: Workspace-scoped definitions cannot promote.",
    );
  }
  const targetRequest = {
    ...request,
    context: {
      ...request.context,
      environmentId: publicId(
        body(request).targetEnvironmentId,
        MOCK_TENANCY_FIXTURE_IDS.environment,
        "targetEnvironmentId",
      ),
    },
  };
  const sourceScope = agentScope(request);
  const targetScope = agentScope(targetRequest);
  if (
    sourceScope.organizationId !== targetScope.organizationId ||
    sourceScope.projectId !== targetScope.projectId
  ) {
    throw new TypeError("cross_project_promotion: Target environment is in another project.");
  }
  const targetDefinition =
    [...state.agentDefinitions.values()].find(
      (definition) =>
        definition.environmentId === targetScope.environmentId &&
        definition.slug === sourceDefinition.slug,
    ) ?? createTargetDefinition(context, targetRequest, sourceDefinition);
  const releases = [...state.agentReleases.values()].filter(
    (release) => release.agentDefinitionId === targetDefinition.id,
  );
  const existing = releases.find((release) => release.contentHash === source.contentHash);
  if (existing) return context.respond(existing);
  const item = agentRelease(
    targetRequest,
    now,
    nextPublicId(state),
    targetDefinition.id,
    source.manifest,
    String(source.contentHash),
    Math.max(0, ...releases.map((release) => Number(release.releaseNumber))) + 1,
  ) as StoredAgentRelease;
  state.agentReleases.set(item.id, item);
  return context.respond(item);
}

function createTargetDefinition(
  { now, state }: RouteContext,
  targetRequest: RouteContext["request"],
  source: StoredAgentDefinition,
): StoredAgentDefinition {
  const item = {
    ...agentDefinition({ ...targetRequest, body: {} }, now, nextPublicId(state)),
    draft: source.draft,
    name: source.name,
    slug: source.slug,
  } as StoredAgentDefinition;
  state.agentDefinitions.set(item.id, item);
  return item;
}
