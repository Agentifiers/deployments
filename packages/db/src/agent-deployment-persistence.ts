import { validateAgentDeploymentConfig } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import {
  deploymentWithoutCanary,
  makeAgentDeploymentCanaryPersistence,
  releaseControlDelta,
  requireConfigSatisfiesReleases,
  requireDeployableRelease,
} from "./agent-deployment-canary-persistence.ts";
import { requireActiveAgentRelease } from "./agent-lifecycle-storage.ts";
import { assertAgentBindingsResolvable } from "./agent-deployment-bindings.ts";
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
  databaseWriteAttempt,
  expectedVersion,
  id,
  updatedDeployment,
  validationMessage,
} from "./agent-lifecycle.ts";
import { type TransactionOperation } from "./client-types.ts";
import { assertClientToolTriggers } from "./client-tool-trigger-validation.ts";
import { PersistenceError } from "./persistence-types.ts";
import { AgentDeploymentRecord } from "./records/control.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";

export function makeAgentDeploymentPersistence(context: AgentLifecycleContext) {
  const {
    dependencies,
    environmentFor,
    generateId,
    getAgentRecord,
    lifecycleEvent,
    listEnvironmentRecords,
    now,
    releaseControlFor,
    releaseControlPut,
  } = context;
  const service: AgentLifecyclePersistence["agentDeployments"] = {
    ...makeAgentDeploymentCanaryPersistence(context),
    async list(invocation) {
      const page = await listEnvironmentRecords<AgentDeployment>(invocation, "agent-deployment");
      return {
        items: page.items.map((record) => agentDeploymentResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const environment = await environmentFor(invocation);
      const releaseInvocation = { ...invocation, id: invocation.body.agentReleaseId };
      const release = await getAgentRecord<AgentRelease>(
        releaseInvocation,
        "agent-release",
        "Agent release",
      );
      if (release.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "release_archived",
          "Archived releases cannot be deployed.",
        );
      }
      const runtimeConfig = invocation.body.runtimeConfig ?? DEFAULT_DEPLOYMENT_CONFIG;
      const validation = validateAgentDeploymentConfig(runtimeConfig, release.data.manifest);
      if (!validation.ok) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_agent_deployment_config",
          validationMessage(validation.issues),
        );
      }
      await assertClientToolTriggers(dependencies.database, release.data, release.data.manifest);
      await assertAgentBindingsResolvable(context, invocation, {
        agentDefinitionId: release.data.agentDefinitionId,
        config: validation.config,
        manifest: release.data.manifest,
      });
      await context.assertManifestAdmitted(release);
      const timestamp = now().toISOString();
      const desiredState = invocation.body.desiredState ?? "running";
      const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: release.data.agentDefinitionId,
            agentReleaseId: release.data.id,
            createdAt: timestamp,
            currentState: desiredState === "running" ? "ready" : "paused",
            desiredState,
            environmentId: id(environment.id),
            id: id(await generateId()),
            lastTransitionAt: timestamp,
            organizationId: id(environment.organizationId),
            projectId: id(environment.projectId),
            ...(invocation.body.runtimeConfig
              ? { runtimeConfig: structuredClone(invocation.body.runtimeConfig) }
              : {}),
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "agent-deployment" as const,
        }),
      );
      const event = await lifecycleEvent(invocation, {
        aggregateId: deployment.data.id,
        aggregateType: "agent-deployment",
        aggregateVersion: 1,
        environmentId: deployment.data.environmentId,
        eventType: "agent-deployment.created",
        occurredAt: timestamp,
        organizationId: deployment.data.organizationId,
        payload: {
          agentDefinitionId: deployment.data.agentDefinitionId,
          agentReleaseId: deployment.data.agentReleaseId,
          currentState: deployment.data.currentState,
          desiredState: deployment.data.desiredState,
          id: deployment.data.id,
        },
        projectId: deployment.data.projectId,
      });
      let currentRelease = release;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (currentRelease.data.status !== "active") {
          throw new PersistenceError(
            "conflict",
            "release_archived",
            "Archived releases cannot be deployed.",
          );
        }
        const control = await releaseControlFor(currentRelease);
        const committed = await databaseWriteAttempt(
          transactWithSemanticEvents(
            dependencies.database,
            [
              requireActiveAgentRelease(currentRelease),
              releaseControlPut(control, timestamp, control.record.data.activeDeploymentCount + 1),
              { kind: "put", record: deployment },
            ],
            [event],
            makePersistenceTransactionToken(invocation, "agent-deployment.create", attempt),
          ),
        );
        if (committed) return agentDeploymentResult(deployment.data);
        currentRelease = await getAgentRecord<AgentRelease>(
          releaseInvocation,
          "agent-release",
          "Agent release",
        );
      }
      throw new PersistenceError(
        "conflict",
        "version_conflict",
        "The release changed repeatedly while creating the deployment.",
      );
    },
    async get(invocation) {
      const record = await getAgentRecord<AgentDeployment>(
        invocation,
        "agent-deployment",
        "Agent deployment",
      );
      return agentDeploymentResult(record.data);
    },
    async update(invocation) {
      const previous = await getAgentRecord<AgentDeployment>(
        invocation,
        "agent-deployment",
        "Agent deployment",
      );
      expectedVersion(previous.data.version, invocation.body.expectedVersion);
      if (previous.data.desiredState === "stopped") {
        throw new PersistenceError(
          "conflict",
          "deployment_stopped",
          "Stopped deployments cannot be updated.",
        );
      }
      const targetId = invocation.body.agentReleaseId;
      const retarget = targetId !== undefined && targetId !== previous.data.agentReleaseId;
      if (retarget && previous.data.candidateAgentReleaseId) {
        throw new PersistenceError(
          "conflict",
          "canary_active",
          "Promote or abort the active canary before retargeting the deployment.",
        );
      }
      const release = await getAgentRecord<AgentRelease>(
        { ...invocation, id: previous.data.agentReleaseId },
        "agent-release",
        "Agent release",
      );
      const target = retarget
        ? await requireDeployableRelease(context, invocation, previous, targetId)
        : release;
      if (target.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "release_archived",
          "Archived releases cannot be restarted.",
        );
      }
      const candidate = previous.data.candidateAgentReleaseId
        ? await getAgentRecord<AgentRelease>(
            { ...invocation, id: previous.data.candidateAgentReleaseId },
            "agent-release",
            "Agent release",
          )
        : undefined;
      if (invocation.body.runtimeConfig || retarget) {
        requireConfigSatisfiesReleases(
          invocation.body.runtimeConfig ?? previous.data.runtimeConfig,
          candidate ? [target, candidate] : [target],
        );
        for (const pinned of candidate ? [target, candidate] : [target]) {
          await assertAgentBindingsResolvable(context, invocation, {
            agentDefinitionId: previous.data.agentDefinitionId,
            config: invocation.body.runtimeConfig ?? previous.data.runtimeConfig,
            deploymentId: previous.data.id,
            manifest: pinned.data.manifest,
          });
        }
      }
      if (retarget) {
        await assertClientToolTriggers(dependencies.database, target.data, target.data.manifest);
      }
      const desiredState = invocation.body.desiredState ?? previous.data.desiredState;
      // A retarget is admitted against the environment's model policy even while paused; a
      // resume re-admits every release the deployment will run (primary and active candidate).
      if (retarget || desiredState === "running") {
        for (const pinned of candidate ? [target, candidate] : [target]) {
          await context.assertManifestAdmitted(pinned);
        }
      }
      const timestamp = now().toISOString();
      const next = updatedDeployment(previous, timestamp, {
        agentReleaseId: target.data.id,
        currentState: desiredState === "running" ? "ready" : "paused",
        desiredState,
        lastTransitionAt: timestamp,
        ...(invocation.body.runtimeConfig
          ? { runtimeConfig: structuredClone(invocation.body.runtimeConfig) }
          : {}),
      });
      const event = await lifecycleEvent(invocation, {
        aggregateId: next.data.id,
        aggregateType: "agent-deployment",
        environmentId: next.data.environmentId,
        eventType: "agent-deployment.updated",
        occurredAt: timestamp,
        organizationId: next.data.organizationId,
        payload: {
          agentDefinitionId: next.data.agentDefinitionId,
          agentReleaseId: next.data.agentReleaseId,
          currentState: next.data.currentState,
          desiredState: next.data.desiredState,
          id: next.data.id,
          ...(retarget ? { previousAgentReleaseId: previous.data.agentReleaseId } : {}),
        },
        projectId: next.data.projectId,
      });
      const controlTransfer = retarget
        ? [
            await releaseControlDelta(context, release, timestamp, -1),
            await releaseControlDelta(context, target, timestamp, 1),
          ]
        : [];
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          [
            requireActiveAgentRelease(target),
            ...(candidate ? [requireActiveAgentRelease(candidate)] : []),
            ...controlTransfer,
            { kind: "put", previousRecord: previous, record: next },
          ],
          [event],
          makePersistenceTransactionToken(invocation, "agent-deployment.update"),
        ),
        { code: "version_conflict", message: "The deployment or release changed concurrently." },
      );
      return agentDeploymentResult(next.data);
    },
    async stop(invocation) {
      const previous = await getAgentRecord<AgentDeployment>(
        invocation,
        "agent-deployment",
        "Agent deployment",
      );
      expectedVersion(previous.data.version, invocation.body.expectedVersion);
      const timestamp = now().toISOString();
      const next = updatedDeployment(deploymentWithoutCanary(previous), timestamp, {
        currentState: "stopped",
        desiredState: "stopped",
        lastTransitionAt: timestamp,
      });
      const operations: TransactionOperation[] = [
        { kind: "put", previousRecord: previous, record: next },
      ];
      if (previous.data.currentState !== "stopped") {
        const pinned = [previous.data.agentReleaseId, previous.data.candidateAgentReleaseId];
        for (const releaseId of pinned) {
          if (!releaseId) continue;
          const release = await getAgentRecord<AgentRelease>(
            { ...invocation, id: releaseId },
            "agent-release",
            "Agent release",
          );
          operations.unshift(await releaseControlDelta(context, release, timestamp, -1));
        }
      }
      const event = await lifecycleEvent(invocation, {
        aggregateId: next.data.id,
        aggregateType: "agent-deployment",
        environmentId: next.data.environmentId,
        eventType: "agent-deployment.stopped",
        occurredAt: timestamp,
        organizationId: next.data.organizationId,
        payload: {
          agentDefinitionId: next.data.agentDefinitionId,
          agentReleaseId: next.data.agentReleaseId,
          currentState: next.data.currentState,
          desiredState: next.data.desiredState,
          id: next.data.id,
        },
        projectId: next.data.projectId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          operations,
          [event],
          makePersistenceTransactionToken(invocation, "agent-deployment.stop"),
        ),
        {
          code: "version_conflict",
          message: "The resource version has changed.",
        },
      );
      return agentDeploymentResult(next.data);
    },
  };
  return service;
}
