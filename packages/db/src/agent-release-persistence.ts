import { validateAgentManifest } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import {
  makeAgentReleaseControlRecord,
  requireUnusedAgentRelease,
} from "./agent-lifecycle-storage.ts";
import type {
  AgentDefinition,
  AgentLifecycleContext,
  AgentLifecyclePersistence,
  AgentRelease,
} from "./agent-lifecycle-types.ts";
import { makeAgentReleasePromotion } from "./agent-release-promotion-persistence.ts";
import {
  agentReleaseResult,
  agentReleaseSummaryResult,
  databaseValue,
  databaseWriteAttempt,
  expectedVersion,
  id,
  updatedDefinition,
  updatedRelease,
  validationMessage,
} from "./agent-lifecycle.ts";
import { snapshotReleaseHostedCodeTools } from "./hosted-code/release-pins.ts";
import { PersistenceError } from "./persistence-types.ts";
import { assertClientToolTriggers } from "./client-tool-trigger-validation.ts";
import { AgentReleaseRecord } from "./records/control.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";

export function makeAgentReleasePersistence(context: AgentLifecycleContext) {
  const {
    dependencies,
    generateId,
    getAgentRecord,
    lastReleaseNumber,
    lifecycleEvent,
    now,
    recordStore,
    releaseControlFor,
    releaseControlPut,
  } = context;
  const service: AgentLifecyclePersistence["agentReleases"] = {
    async list(invocation) {
      const definition = await getAgentRecord<AgentDefinition>(
        invocation,
        "agent-definition",
        "Agent definition",
      );
      await databaseValue(recordStore.ensureReleaseIndex(definition, now().toISOString()));
      const result = await databaseValue(
        recordStore.listReleases(definition, {
          ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
          limit: invocation.query.limit ?? 50,
        }),
      );
      const releases = result.items.filter(
        (record): record is AgentRelease => record.itemType === "agent-release",
      );
      return {
        items: releases.map((release) => agentReleaseSummaryResult(release.data)),
        nextCursor: result.nextCursor,
      };
    },
    async publish(invocation) {
      const definition = await getAgentRecord<AgentDefinition>(
        invocation,
        "agent-definition",
        "Agent definition",
      );
      expectedVersion(definition.data.version, invocation.body.expectedDefinitionVersion);
      if (definition.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "definition_archived",
          "Archived definitions cannot publish.",
        );
      }
      const validation = validateAgentManifest(definition.data.draft);
      if (!validation.ok) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_agent_manifest",
          validationMessage(validation.issues),
        );
      }
      await assertClientToolTriggers(dependencies.database, definition.data, validation.manifest);
      await context.assertManifestAdmitted({
        manifest: validation.manifest,
        scope: {
          agentDefinitionId: definition.data.id,
          environmentId: definition.data.environmentId,
          organizationId: definition.data.organizationId,
          projectId: definition.data.projectId,
        },
      });
      const timestamp = now().toISOString();
      const releaseNumber = (await lastReleaseNumber(definition)) + 1;
      const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: definition.data.id,
            contentHash: validation.contentHash,
            createdAt: timestamp,
            createdByPrincipalId: id(invocation.identity.principalId),
            environmentId: definition.data.environmentId,
            id: id(await generateId()),
            manifest: structuredClone(validation.manifest),
            organizationId: definition.data.organizationId,
            projectId: definition.data.projectId,
            releaseNumber,
            status: "active" as const,
            version: 0,
          },
          itemType: "agent-release" as const,
        }),
      );
      const hostedCode = await databaseValue(
        snapshotReleaseHostedCodeTools(dependencies.database, {
          agentReleaseId: release.data.id,
          createdAt: timestamp,
          environmentId: release.data.environmentId,
          manifest: release.data.manifest,
          organizationId: release.data.organizationId,
          projectId: release.data.projectId,
        }),
      );
      if (hostedCode.issues.length > 0) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_agent_manifest",
          validationMessage(hostedCode.issues),
        );
      }
      const nextDefinition = updatedDefinition(definition, timestamp, {
        lastReleaseNumber: releaseNumber,
      });
      const control = makeAgentReleaseControlRecord(release, timestamp, 0);
      const definitionEvent = await lifecycleEvent(invocation, {
        aggregateId: nextDefinition.data.id,
        aggregateType: "agent-definition",
        environmentId: nextDefinition.data.environmentId,
        eventType: "agent-definition.release-published",
        occurredAt: timestamp,
        organizationId: nextDefinition.data.organizationId,
        payload: {
          agentReleaseId: release.data.id,
          id: nextDefinition.data.id,
          releaseNumber,
        },
        projectId: nextDefinition.data.projectId,
      });
      const releaseEvent = await lifecycleEvent(invocation, {
        aggregateId: release.data.id,
        aggregateType: "agent-release",
        aggregateVersion: 1,
        environmentId: release.data.environmentId,
        eventType: "agent-release.published",
        occurredAt: timestamp,
        organizationId: release.data.organizationId,
        payload: {
          agentDefinitionId: release.data.agentDefinitionId,
          id: release.data.id,
          releaseNumber,
          status: release.data.status,
        },
        projectId: release.data.projectId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          [
            { kind: "put", previousRecord: definition, record: nextDefinition },
            { kind: "put", record: release },
            { kind: "put", record: control },
            ...hostedCode.pins.map((record) => ({ kind: "put" as const, record })),
          ],
          [definitionEvent, releaseEvent],
          makePersistenceTransactionToken(invocation, "agent-release.publish"),
        ),
        { code: "version_conflict", message: "The agent definition changed concurrently." },
      );
      return agentReleaseResult(release.data);
    },
    async get(invocation) {
      const record = await getAgentRecord<AgentRelease>(
        invocation,
        "agent-release",
        "Agent release",
      );
      return agentReleaseResult(record.data);
    },
    promote: makeAgentReleasePromotion(context),
    async archive(invocation) {
      let previous = await getAgentRecord<AgentRelease>(
        invocation,
        "agent-release",
        "Agent release",
      );
      expectedVersion(previous.data.version, invocation.body.expectedVersion);
      if (previous.data.status === "archived") {
        return agentReleaseResult(previous.data);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const control = await releaseControlFor(previous);
        if (control.record.data.activeDeploymentCount > 0) {
          throw new PersistenceError(
            "conflict",
            "release_in_use",
            "Active deployments still pin this release.",
          );
        }
        const next = updatedRelease(previous, { status: "archived" });
        const timestamp = now().toISOString();
        const controlOperation = control.persisted
          ? requireUnusedAgentRelease(control.record)
          : releaseControlPut(control, timestamp, 0);
        const event = await lifecycleEvent(invocation, {
          aggregateId: next.data.id,
          aggregateType: "agent-release",
          environmentId: next.data.environmentId,
          eventType: "agent-release.archived",
          occurredAt: timestamp,
          organizationId: next.data.organizationId,
          payload: {
            agentDefinitionId: next.data.agentDefinitionId,
            id: next.data.id,
            releaseNumber: next.data.releaseNumber,
            status: next.data.status,
          },
          projectId: next.data.projectId,
        });
        const committed = await databaseWriteAttempt(
          transactWithSemanticEvents(
            dependencies.database,
            [controlOperation, { kind: "put", previousRecord: previous, record: next }],
            [event],
            makePersistenceTransactionToken(invocation, "agent-release.archive", attempt),
          ),
        );
        if (committed) return agentReleaseResult(next.data);
        previous = await getAgentRecord<AgentRelease>(invocation, "agent-release", "Agent release");
        expectedVersion(previous.data.version, invocation.body.expectedVersion);
      }
      throw new PersistenceError("conflict", "version_conflict", "The release changed repeatedly.");
    },
  };
  return service;
}
