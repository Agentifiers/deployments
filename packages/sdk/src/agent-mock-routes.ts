import type {
  StoredAgentDefinition,
  StoredAgentDeployment,
  StoredAgentRelease,
  TenancyMockResult,
  TenancyMockRouteContext,
} from "./tenancy-mock.ts";
import {
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  agentDefinition,
  agentDefinitionSummary,
  agentDeployment,
  agentRelease,
  agentReleaseSummary,
  assertDefinitionKeyAvailable,
  assertDeploymentConfig,
  assertExpectedVersion,
  body,
  fixtureAgentRequest,
  manifestContentHash,
  nextPublicId,
  optionalString,
  page,
  publicId,
  requireAgentDefinition,
  requireAgentDeployment,
  requireAgentRelease,
  scope,
} from "./tenancy-mock.ts";
import { requireRetargetRelease } from "./agent-release-lifecycle-mock-routes.ts";

export async function handleAgentMockRoutes(
  context: TenancyMockRouteContext,
): Promise<TenancyMockResult | undefined> {
  const {
    id,
    inputRequest: _inputRequest,
    issued: _issued,
    listQuery,
    now,
    request,
    respond,
    routeName,
    state,
  } = context;
  switch (routeName) {
    case "listAgentDefinitions": {
      const environmentId = scope(request).environmentId;
      const items = [...state.agentDefinitions.values()]
        .filter((definition) => definition.environmentId === environmentId)
        .map(({ draft: _draft, ...summary }) => summary);
      if (
        environmentId === MOCK_TENANCY_CONTEXT.environmentId &&
        !state.agentDefinitions.has(MOCK_TENANCY_FIXTURE_IDS.agentDefinition)
      ) {
        items.unshift(
          agentDefinitionSummary(
            fixtureAgentRequest(request),
            now,
            MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
          ),
        );
      }
      return respond(page(items, listQuery));
    }
    case "createAgentDefinition": {
      const item = agentDefinition(request, now, nextPublicId(state)) as StoredAgentDefinition;
      assertDefinitionKeyAvailable(state, String(item.environmentId), String(item.slug));
      state.agentDefinitions.set(item.id, item);
      return respond(item);
    }
    case "getAgentDefinition": {
      return respond(
        requireAgentDefinition(state, request, now, id ?? MOCK_TENANCY_FIXTURE_IDS.agentDefinition),
      );
    }
    case "updateAgentDefinition": {
      const definitionId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDefinition;
      const prior = requireAgentDefinition(state, request, now, definitionId);
      if (prior.status === "archived") {
        throw new TypeError("Archived definitions cannot be updated.");
      }
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...agentDefinition(request, now, definitionId),
        createdAt: prior.createdAt,
        version: prior.version + 1,
      } as StoredAgentDefinition;
      assertDefinitionKeyAvailable(
        state,
        String(item.environmentId),
        String(item.slug),
        definitionId,
      );
      state.agentDefinitions.set(definitionId, item);
      return respond(item);
    }
    case "archiveAgentDefinition": {
      const definitionId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDefinition;
      const prior = requireAgentDefinition(state, request, now, definitionId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        status: "archived",
        updatedAt: now,
        version: prior.version + 1,
      } as StoredAgentDefinition;
      state.agentDefinitions.set(definitionId, item);
      return respond(item);
    }
    case "listAgentReleases": {
      const definitionId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDefinition;
      requireAgentDefinition(state, request, now, definitionId);
      const items = [...state.agentReleases.values()]
        .filter((release) => release.agentDefinitionId === definitionId)
        .map(({ manifest: _manifest, ...summary }) => summary);
      if (
        definitionId === MOCK_TENANCY_FIXTURE_IDS.agentDefinition &&
        !state.agentReleases.has(MOCK_TENANCY_FIXTURE_IDS.agentRelease)
      ) {
        items.unshift(
          agentReleaseSummary(
            fixtureAgentRequest(request),
            now,
            MOCK_TENANCY_FIXTURE_IDS.agentRelease,
            definitionId,
          ),
        );
      }
      return respond(page(items, listQuery));
    }
    case "getAgentRelease": {
      const releaseId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentRelease;
      return respond(requireAgentRelease(state, request, now, releaseId));
    }
    case "archiveAgentRelease": {
      const releaseId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentRelease;
      const prior = requireAgentRelease(state, request, now, releaseId);
      assertExpectedVersion(Number(prior.version), body(request).expectedVersion);
      if (prior.status === "archived") return respond(prior);
      const cannedDeploymentPinsRelease =
        releaseId === MOCK_TENANCY_FIXTURE_IDS.agentRelease &&
        !state.agentDeployments.has(MOCK_TENANCY_FIXTURE_IDS.agentDeployment);
      if (
        cannedDeploymentPinsRelease ||
        [...state.agentDeployments.values()].some(
          (deployment) =>
            deployment.agentReleaseId === releaseId && deployment.currentState !== "stopped",
        )
      ) {
        throw new TypeError("Active deployments still pin this release.");
      }
      const item = {
        ...prior,
        status: "archived",
        version: Number(prior.version) + 1,
      } as StoredAgentRelease;
      state.agentReleases.set(releaseId, item);
      return respond(item);
    }
    case "publishAgentRelease": {
      const definitionId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDefinition;
      const storedDefinition = requireAgentDefinition(state, request, now, definitionId);
      assertExpectedVersion(storedDefinition.version, body(request).expectedDefinitionVersion);
      if (storedDefinition.status === "archived") {
        throw new TypeError("Archived definitions cannot publish.");
      }
      const manifest = storedDefinition.draft;
      const existingReleases = [...state.agentReleases.values()].filter(
        (release) => release.agentDefinitionId === definitionId,
      );
      const releaseNumber =
        Math.max(0, ...existingReleases.map((release) => Number(release.releaseNumber))) + 1;
      const releaseId =
        definitionId === MOCK_TENANCY_FIXTURE_IDS.agentDefinition && existingReleases.length === 0
          ? MOCK_TENANCY_FIXTURE_IDS.agentRelease
          : nextPublicId(state);
      const item = agentRelease(
        request,
        now,
        releaseId,
        definitionId,
        manifest,
        await manifestContentHash(manifest),
        releaseNumber,
      ) as StoredAgentRelease;
      state.agentReleases.set(releaseId, item);
      state.agentDefinitions.set(definitionId, {
        ...storedDefinition,
        updatedAt: now,
        version: storedDefinition.version + 1,
      });
      return respond(item);
    }
    case "listAgentDeployments": {
      const environmentId = scope(request).environmentId;
      const items = [...state.agentDeployments.values()].filter(
        (deployment) => deployment.environmentId === environmentId,
      );
      if (
        environmentId === MOCK_TENANCY_CONTEXT.environmentId &&
        !state.agentDeployments.has(MOCK_TENANCY_FIXTURE_IDS.agentDeployment)
      ) {
        items.unshift(
          agentDeployment(
            fixtureAgentRequest(request),
            now,
            MOCK_TENANCY_FIXTURE_IDS.agentDeployment,
          ),
        );
      }
      return respond(page(items, listQuery));
    }
    case "createAgentDeployment": {
      const input = body(request);
      const releaseId = publicId(
        input.agentReleaseId,
        MOCK_TENANCY_FIXTURE_IDS.agentRelease,
        "agentReleaseId",
      );
      const release = requireAgentRelease(state, request, now, releaseId);
      if (release.status === "archived") {
        throw new TypeError("Archived releases cannot be deployed.");
      }
      assertDeploymentConfig(
        release.manifest,
        input.runtimeConfig ?? {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
        },
      );
      const item = agentDeployment(
        request,
        now,
        nextPublicId(state),
        release.agentDefinitionId,
        releaseId,
      ) as StoredAgentDeployment;
      state.agentDeployments.set(item.id, item);
      return respond(item);
    }
    case "getAgentDeployment": {
      const deploymentId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDeployment;
      return respond(requireAgentDeployment(state, request, now, deploymentId));
    }
    case "updateAgentDeployment": {
      const deploymentId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDeployment;
      const prior = requireAgentDeployment(state, request, now, deploymentId);
      const input = body(request);
      assertExpectedVersion(prior.version, input.expectedVersion);
      if (prior.desiredState === "stopped") {
        throw new TypeError("Stopped deployments cannot be updated.");
      }
      if (input.agentReleaseId !== undefined && typeof input.agentReleaseId !== "string") {
        throw new TypeError("agentReleaseId must be a string.");
      }
      const release =
        input.agentReleaseId === undefined
          ? requireAgentRelease(state, request, now, prior.agentReleaseId)
          : requireRetargetRelease(context, prior, input.agentReleaseId);
      if (release.status === "archived") {
        throw new TypeError("Archived releases cannot be restarted.");
      }
      if (input.runtimeConfig) assertDeploymentConfig(release.manifest, input.runtimeConfig);
      const desiredState = optionalString(input.desiredState) ?? prior.desiredState;
      const retarget = input.agentReleaseId === undefined ? {} : { agentReleaseId: release.id };
      const item = {
        ...prior,
        currentState: desiredState === "running" ? "ready" : "paused",
        desiredState,
        ...retarget,
        lastTransitionAt: now,
        ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
        updatedAt: now,
        version: prior.version + 1,
      } as StoredAgentDeployment;
      state.agentDeployments.set(deploymentId, item);
      return respond(item);
    }
    case "stopAgentDeployment": {
      const deploymentId = id ?? MOCK_TENANCY_FIXTURE_IDS.agentDeployment;
      const prior = requireAgentDeployment(state, request, now, deploymentId);
      assertExpectedVersion(prior.version, body(request).expectedVersion);
      const item = {
        ...prior,
        currentState: "stopped",
        desiredState: "stopped",
        lastTransitionAt: now,
        updatedAt: now,
        version: prior.version + 1,
      } as StoredAgentDeployment;
      state.agentDeployments.set(deploymentId, item);
      return respond(item);
    }
    default:
      return undefined;
  }
}
