import {
  validateAgentDeploymentConfig,
  validateAgentManifest,
} from "@deployments-ai/agent-manifest";
import { ApiProblem, type TenancyApiService } from "@deployments-ai/api";
import {
  agentDefinitionResponse,
  agentDefinitionSummaryResponse,
  agentDeploymentResponse,
  agentReleaseResponse,
  agentReleaseSummaryResponse,
} from "@deployments-ai/api-contract";
import type {
  AgentDefinitionRecord,
  AgentDeploymentRecord,
  AgentReleaseRecord,
  TenancyFixtureContext,
} from "./index.ts";
import {} from "./index.ts";

export function makeAgentFixtureServices(context: TenancyFixtureContext) {
  const {
    now,
    id,
    state,
    memberships: _memberships,
    idempotencyValues: _idempotencyValues,
    adminToken: _adminToken,
    adminPrincipalId: _adminPrincipalId,
    identityFor: _identityFor,
    page,
    createRecord: _createRecord,
    createAgentRecord,
    get,
    unique,
    updateRecord,
    assertScope,
    expectedVersion,
    environmentFor,
  } = context;

  const agentDefinitions: TenancyApiService["agentDefinitions"] = {
    async list(invocation) {
      return page(
        [...state.agentDefinitions.values()]
          .filter((item) => item.environmentId === invocation.scope.environmentId)
          .map(agentDefinitionSummaryResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const environment = environmentFor(invocation);
      const manifest = structuredClone(invocation.body.manifest);
      unique(
        state.agentDefinitions,
        (item) => item.environmentId === environment.id && item.slug === manifest.metadata.key,
        "Agent definition key",
      );
      const item: AgentDefinitionRecord = createAgentRecord({
        draft: manifest,
        environmentId: environment.id,
        id: id(),
        name: manifest.metadata.name,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        slug: manifest.metadata.key,
        status: "active",
      });
      state.agentDefinitions.set(item.id, item);
      return agentDefinitionResponse(item);
    },
    async get(invocation) {
      const item = get(state.agentDefinitions, invocation.id, "Agent definition");
      assertScope({ environmentId: item.environmentId }, invocation);
      return agentDefinitionResponse(item);
    },
    async update(invocation) {
      const item = get(state.agentDefinitions, invocation.id, "Agent definition");
      assertScope({ environmentId: item.environmentId }, invocation);
      expectedVersion(item.version, invocation.body.expectedVersion);
      if (item.status !== "active") {
        throw new ApiProblem(409, "definition_archived", "Archived definitions cannot be updated.");
      }
      const manifest = structuredClone(invocation.body.manifest);
      unique(
        state.agentDefinitions,
        (entry) =>
          entry.environmentId === item.environmentId && entry.slug === manifest.metadata.key,
        "Agent definition key",
        item.id,
      );
      const next = updateRecord(item, {
        draft: manifest,
        name: manifest.metadata.name,
        slug: manifest.metadata.key,
      });
      state.agentDefinitions.set(item.id, next);
      return agentDefinitionResponse(next);
    },
    async archive(invocation) {
      const item = get(state.agentDefinitions, invocation.id, "Agent definition");
      assertScope({ environmentId: item.environmentId }, invocation);
      expectedVersion(item.version, invocation.body.expectedVersion);
      const next = updateRecord(item, { status: "archived" });
      state.agentDefinitions.set(item.id, next);
      return agentDefinitionResponse(next);
    },
  };

  const agentReleases: TenancyApiService["agentReleases"] = {
    async list(invocation) {
      const definition = get(state.agentDefinitions, invocation.id, "Agent definition");
      assertScope({ environmentId: definition.environmentId }, invocation);
      return page(
        [...state.agentReleases.values()]
          .filter((item) => item.agentDefinitionId === definition.id)
          .sort((left, right) => left.releaseNumber - right.releaseNumber)
          .map(agentReleaseSummaryResponse),
        invocation.query,
      );
    },
    async publish(invocation) {
      const definition = get(state.agentDefinitions, invocation.id, "Agent definition");
      assertScope({ environmentId: definition.environmentId }, invocation);
      expectedVersion(definition.version, invocation.body.expectedDefinitionVersion);
      if (definition.status !== "active") {
        throw new ApiProblem(409, "definition_archived", "Archived definitions cannot publish.");
      }
      const validation = validateAgentManifest(definition.draft);
      if (!validation.ok) {
        throw new ApiProblem(
          422,
          "invalid_agent_manifest",
          validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
        );
      }
      const releaseNumber =
        Math.max(
          0,
          ...[...state.agentReleases.values()]
            .filter((item) => item.agentDefinitionId === definition.id)
            .map((item) => item.releaseNumber),
        ) + 1;
      const item: AgentReleaseRecord = {
        agentDefinitionId: definition.id,
        contentHash: validation.contentHash,
        createdAt: now(),
        createdByPrincipalId: invocation.identity.principalId,
        environmentId: definition.environmentId,
        id: id(),
        manifest: structuredClone(validation.manifest),
        organizationId: definition.organizationId,
        projectId: definition.projectId,
        releaseNumber,
        status: "active",
        version: 0,
      };
      state.agentReleases.set(item.id, item);
      state.agentDefinitions.set(definition.id, updateRecord(definition, {}));
      return agentReleaseResponse(item);
    },
    async promote() {
      throw new ApiProblem(501, "not_supported", "Fixture services do not promote releases.");
    },
    async get(invocation) {
      const item = get(state.agentReleases, invocation.id, "Agent release");
      assertScope({ environmentId: item.environmentId }, invocation);
      return agentReleaseResponse(item);
    },
    async archive(invocation) {
      const item = get(state.agentReleases, invocation.id, "Agent release");
      assertScope({ environmentId: item.environmentId }, invocation);
      expectedVersion(item.version, invocation.body.expectedVersion);
      if (
        [...state.agentDeployments.values()].some(
          (deployment) =>
            deployment.agentReleaseId === item.id && deployment.currentState !== "stopped",
        )
      ) {
        throw new ApiProblem(409, "release_in_use", "Active deployments still pin this release.");
      }
      const next: AgentReleaseRecord = { ...item, status: "archived", version: item.version + 1 };
      state.agentReleases.set(item.id, next);
      return agentReleaseResponse(next);
    },
  };

  const agentDeployments: TenancyApiService["agentDeployments"] = {
    async list(invocation) {
      return page(
        [...state.agentDeployments.values()]
          .filter((item) => item.environmentId === invocation.scope.environmentId)
          .map(agentDeploymentResponse),
        invocation.query,
      );
    },
    async create(invocation) {
      const environment = environmentFor(invocation);
      const release = get(state.agentReleases, invocation.body.agentReleaseId, "Agent release");
      assertScope({ environmentId: release.environmentId }, invocation);
      if (release.status !== "active") {
        throw new ApiProblem(409, "release_archived", "Archived releases cannot be deployed.");
      }
      const runtimeConfig =
        invocation.body.runtimeConfig ??
        ({ apiVersion: "agents.deployments.ai/v1", kind: "AgentDeploymentConfig" } as const);
      const validation = validateAgentDeploymentConfig(runtimeConfig, release.manifest);
      if (!validation.ok) {
        throw new ApiProblem(
          422,
          "invalid_agent_deployment_config",
          validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
        );
      }
      const desiredState = invocation.body.desiredState ?? "running";
      const item: AgentDeploymentRecord = createAgentRecord({
        agentDefinitionId: release.agentDefinitionId,
        agentReleaseId: release.id,
        currentState: desiredState === "running" ? "ready" : "paused",
        desiredState,
        environmentId: environment.id,
        id: id(),
        lastTransitionAt: now(),
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        ...(invocation.body.runtimeConfig
          ? { runtimeConfig: structuredClone(invocation.body.runtimeConfig) }
          : {}),
      });
      state.agentDeployments.set(item.id, item);
      return agentDeploymentResponse(item);
    },
    async get(invocation) {
      const item = get(state.agentDeployments, invocation.id, "Agent deployment");
      assertScope({ environmentId: item.environmentId }, invocation);
      return agentDeploymentResponse(item);
    },
    async update(invocation) {
      const item = get(state.agentDeployments, invocation.id, "Agent deployment");
      assertScope({ environmentId: item.environmentId }, invocation);
      expectedVersion(item.version, invocation.body.expectedVersion);
      if (item.desiredState === "stopped") {
        throw new ApiProblem(409, "deployment_stopped", "Stopped deployments cannot be updated.");
      }
      const release = get(state.agentReleases, item.agentReleaseId, "Agent release");
      const desiredState = invocation.body.desiredState ?? item.desiredState;
      if (release.status !== "active") {
        throw new ApiProblem(409, "release_archived", "Archived releases cannot be restarted.");
      }
      if (invocation.body.runtimeConfig) {
        const validation = validateAgentDeploymentConfig(
          invocation.body.runtimeConfig,
          release.manifest,
        );
        if (!validation.ok) {
          throw new ApiProblem(
            422,
            "invalid_agent_deployment_config",
            validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
          );
        }
      }
      const currentState = desiredState === "running" ? "ready" : "paused";
      const next = updateRecord(item, {
        currentState,
        desiredState,
        lastTransitionAt: now(),
        ...(invocation.body.runtimeConfig
          ? { runtimeConfig: structuredClone(invocation.body.runtimeConfig) }
          : {}),
      });
      state.agentDeployments.set(item.id, next);
      return agentDeploymentResponse(next);
    },
    async startCanary() {
      throw new ApiProblem(501, "not_supported", "Fixture services do not run canaries.");
    },
    async promoteCanary() {
      throw new ApiProblem(501, "not_supported", "Fixture services do not run canaries.");
    },
    async abortCanary() {
      throw new ApiProblem(501, "not_supported", "Fixture services do not run canaries.");
    },
    async stop(invocation) {
      const item = get(state.agentDeployments, invocation.id, "Agent deployment");
      assertScope({ environmentId: item.environmentId }, invocation);
      expectedVersion(item.version, invocation.body.expectedVersion);
      const next = updateRecord(item, {
        currentState: "stopped",
        desiredState: "stopped",
        lastTransitionAt: now(),
      });
      state.agentDeployments.set(item.id, next);
      return agentDeploymentResponse(next);
    },
  };
  return { agentDefinitions, agentReleases, agentDeployments };
}
