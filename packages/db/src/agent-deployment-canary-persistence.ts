import { validateAgentDeploymentConfig } from "@deployments-ai/agent-manifest";
import { assertAgentBindingsResolvable } from "./agent-deployment-bindings.ts";
import { requireActiveAgentRelease } from "./agent-lifecycle-storage.ts";
import type {
  AgentDeployment,
  AgentLifecycleContext,
  AgentLifecyclePersistence,
  AgentRelease,
} from "./agent-lifecycle-types.ts";
import {
  DEFAULT_DEPLOYMENT_CONFIG,
  agentDeploymentResult,
  databaseValue,
  expectedVersion,
  id,
  updatedDeployment,
  validationMessage,
} from "./agent-lifecycle.ts";
import { type TransactionOperation } from "./client-types.ts";
import { assertClientToolTriggers } from "./client-tool-trigger-validation.ts";
import { type PersistenceInvocation } from "./persistence-types.ts";
import { PersistenceError } from "./persistence-types.ts";
import { transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";

type CanaryOperations = Pick<
  AgentLifecyclePersistence["agentDeployments"],
  "abortCanary" | "promoteCanary" | "startCanary"
>;

/** Loads a release that a deployment may pin: same environment, same definition, active. */
export async function requireDeployableRelease(
  context: AgentLifecycleContext,
  invocation: PersistenceInvocation,
  deployment: AgentDeployment,
  agentReleaseId: string,
): Promise<AgentRelease> {
  const release = await context.getAgentRecord<AgentRelease>(
    { ...invocation, id: agentReleaseId },
    "agent-release",
    "Agent release",
  );
  if (release.data.agentDefinitionId !== deployment.data.agentDefinitionId) {
    throw new PersistenceError(
      "conflict",
      "definition_mismatch",
      "The release belongs to a different agent definition than the deployment.",
    );
  }
  if (release.data.status !== "active") {
    throw new PersistenceError(
      "conflict",
      "release_archived",
      "Archived releases cannot be deployed.",
    );
  }
  return release;
}

/** Requires one runtime configuration to satisfy every release the deployment can select. */
export function requireConfigSatisfiesReleases(
  runtimeConfig: AgentDeployment["data"]["runtimeConfig"],
  releases: readonly AgentRelease[],
) {
  const config = runtimeConfig ?? DEFAULT_DEPLOYMENT_CONFIG;
  for (const release of releases) {
    const validation = validateAgentDeploymentConfig(config, release.data.manifest);
    if (!validation.ok) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_agent_deployment_config",
        validationMessage(validation.issues),
      );
    }
  }
}

/** Builds the release-control put that moves its active deployment count by `delta`. */
export async function releaseControlDelta(
  context: AgentLifecycleContext,
  release: AgentRelease,
  timestamp: string,
  delta: 1 | -1,
): Promise<TransactionOperation> {
  const control = await context.releaseControlFor(release);
  const next = control.record.data.activeDeploymentCount + delta;
  if (next < 0) {
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Agent release deployment count is inconsistent.",
    );
  }
  return context.releaseControlPut(control, timestamp, next);
}

/** Returns the deployment without its canary candidate fields. */
export function deploymentWithoutCanary(previous: AgentDeployment): AgentDeployment {
  const {
    candidateAgentReleaseId: _candidateAgentReleaseId,
    candidateStartedAt: _candidateStartedAt,
    candidateWeight: _candidateWeight,
    ...data
  } = previous.data;
  return { ...previous, data };
}

function requireMutableDeployment(previous: AgentDeployment, expected: number) {
  expectedVersion(previous.data.version, expected);
  if (previous.data.desiredState === "stopped") {
    throw new PersistenceError(
      "conflict",
      "deployment_stopped",
      "Stopped deployments cannot be updated.",
    );
  }
}

function requireActiveCanary(previous: AgentDeployment) {
  const candidateId = previous.data.candidateAgentReleaseId;
  if (!candidateId) {
    throw new PersistenceError(
      "conflict",
      "canary_not_active",
      "The deployment does not have an active canary.",
    );
  }
  return candidateId;
}

export function makeAgentDeploymentCanaryPersistence(
  context: AgentLifecycleContext,
): CanaryOperations {
  const { dependencies, getAgentRecord, lifecycleEvent, now } = context;

  async function commit(
    invocation: PersistenceInvocation,
    input: {
      readonly eventType: string;
      readonly next: AgentDeployment;
      readonly operations: readonly TransactionOperation[];
      readonly payload: Readonly<Record<string, string | number | boolean | null>>;
      readonly previous: AgentDeployment;
      readonly timestamp: string;
      readonly tokenName: string;
    },
  ) {
    const event = await lifecycleEvent(invocation, {
      aggregateId: input.next.data.id,
      aggregateType: "agent-deployment",
      environmentId: input.next.data.environmentId,
      eventType: input.eventType,
      occurredAt: input.timestamp,
      organizationId: input.next.data.organizationId,
      payload: {
        agentDefinitionId: input.next.data.agentDefinitionId,
        agentReleaseId: input.next.data.agentReleaseId,
        currentState: input.next.data.currentState,
        desiredState: input.next.data.desiredState,
        id: input.next.data.id,
        ...input.payload,
      },
      projectId: input.next.data.projectId,
    });
    await databaseValue(
      transactWithSemanticEvents(
        dependencies.database,
        [...input.operations, { kind: "put", previousRecord: input.previous, record: input.next }],
        [event],
        makePersistenceTransactionToken(invocation, input.tokenName),
      ),
      { code: "version_conflict", message: "The deployment or its releases changed concurrently." },
    );
    return agentDeploymentResult(input.next.data);
  }

  async function currentDeployment(invocation: PersistenceInvocation) {
    return getAgentRecord<AgentDeployment>(invocation, "agent-deployment", "Agent deployment");
  }

  return {
    async startCanary(invocation) {
      const previous = await currentDeployment(invocation);
      requireMutableDeployment(previous, invocation.body.expectedVersion);
      if (previous.data.candidateAgentReleaseId) {
        throw new PersistenceError(
          "conflict",
          "canary_already_active",
          "The deployment already has an active canary; promote or abort it first.",
        );
      }
      const weight = invocation.body.weight;
      if (!Number.isInteger(weight) || weight < 1 || weight > 99) {
        throw new PersistenceError(
          "invalid-input",
          "weight_invalid",
          "Canary weight must be an integer from 1 to 99.",
        );
      }
      if (invocation.body.candidateAgentReleaseId === previous.data.agentReleaseId) {
        throw new PersistenceError(
          "unprocessable",
          "candidate_same_as_primary",
          "The canary candidate must differ from the deployment's primary release.",
        );
      }
      const [primary, candidate] = await Promise.all([
        requireDeployableRelease(context, invocation, previous, previous.data.agentReleaseId),
        requireDeployableRelease(
          context,
          invocation,
          previous,
          invocation.body.candidateAgentReleaseId,
        ),
      ]);
      requireConfigSatisfiesReleases(previous.data.runtimeConfig, [primary, candidate]);
      await assertAgentBindingsResolvable(context, invocation, {
        agentDefinitionId: previous.data.agentDefinitionId,
        config: previous.data.runtimeConfig,
        deploymentId: previous.data.id,
        manifest: candidate.data.manifest,
      });
      await assertClientToolTriggers(
        dependencies.database,
        candidate.data,
        candidate.data.manifest,
      );
      await context.assertManifestAdmitted(candidate);
      const timestamp = now().toISOString();
      const next = updatedDeployment(previous, timestamp, {
        candidateAgentReleaseId: candidate.data.id,
        candidateStartedAt: timestamp,
        candidateWeight: weight,
      });
      return commit(invocation, {
        eventType: "agent-deployment.canary-started",
        next,
        operations: [
          requireActiveAgentRelease(primary),
          requireActiveAgentRelease(candidate),
          await releaseControlDelta(context, candidate, timestamp, 1),
        ],
        payload: { candidateAgentReleaseId: candidate.data.id, candidateWeight: weight },
        previous,
        timestamp,
        tokenName: "agent-deployment.canary-start",
      });
    },
    async promoteCanary(invocation) {
      const previous = await currentDeployment(invocation);
      requireMutableDeployment(previous, invocation.body.expectedVersion);
      const candidateId = requireActiveCanary(previous);
      const [primary, candidate] = await Promise.all([
        getAgentRecord<AgentRelease>(
          { ...invocation, id: previous.data.agentReleaseId },
          "agent-release",
          "Agent release",
        ),
        requireDeployableRelease(context, invocation, previous, candidateId),
      ]);
      const timestamp = now().toISOString();
      const next = updatedDeployment(deploymentWithoutCanary(previous), timestamp, {
        agentReleaseId: id(candidate.data.id),
      });
      return commit(invocation, {
        eventType: "agent-deployment.canary-promoted",
        next,
        // The candidate already carries this deployment in its control count.
        operations: [
          requireActiveAgentRelease(candidate),
          await releaseControlDelta(context, primary, timestamp, -1),
        ],
        payload: { previousAgentReleaseId: primary.data.id },
        previous,
        timestamp,
        tokenName: "agent-deployment.canary-promote",
      });
    },
    async abortCanary(invocation) {
      const previous = await currentDeployment(invocation);
      requireMutableDeployment(previous, invocation.body.expectedVersion);
      const candidateId = requireActiveCanary(previous);
      const candidate = await getAgentRecord<AgentRelease>(
        { ...invocation, id: candidateId },
        "agent-release",
        "Agent release",
      );
      const timestamp = now().toISOString();
      const next = updatedDeployment(deploymentWithoutCanary(previous), timestamp, {});
      return commit(invocation, {
        eventType: "agent-deployment.canary-aborted",
        next,
        operations: [await releaseControlDelta(context, candidate, timestamp, -1)],
        payload: { candidateAgentReleaseId: candidate.data.id },
        previous,
        timestamp,
        tokenName: "agent-deployment.canary-abort",
      });
    },
  };
}
