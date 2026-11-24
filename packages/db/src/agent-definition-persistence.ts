import {
  makeAgentDefinitionReleaseIndexRecord,
  requireActiveWorkspace,
} from "./agent-lifecycle-storage.ts";
import type {
  AgentDefinition,
  AgentEnvironmentScope,
  AgentLifecycleContext,
  AgentLifecyclePersistence,
} from "./agent-lifecycle-types.ts";
import {
  agentDefinitionResult,
  agentDefinitionSummaryResult,
  databaseValue,
  definitionRecord,
  expectedVersion,
  id,
  uniqueClaim,
  updatedDefinition,
} from "./agent-lifecycle.ts";
import { type TransactionOperation } from "./client-types.ts";
import { PersistenceError } from "./persistence-types.ts";
import { transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";
import {
  acquireUniqueClaim,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "./unique-claims.ts";

export function makeAgentDefinitionPersistence(context: AgentLifecycleContext) {
  const {
    dependencies,
    environmentFor,
    generateId,
    getAgentRecord,
    lifecycleEvent,
    listEnvironmentRecords,
    now,
    recordStore,
  } = context;

  async function activeWorkspace(environment: AgentEnvironmentScope, workspaceId: string) {
    const workspace = await databaseValue(
      recordStore.getEnvironmentRecord(
        { environmentId: environment.id, organizationId: environment.organizationId },
        "workspace",
        workspaceId,
      ),
    );
    if (workspace?.itemType !== "workspace") {
      throw new PersistenceError("not-found", "resource_not_found", "Workspace was not found.");
    }
    if (workspace.data.status !== "active") {
      throw new PersistenceError("conflict", "workspace_unavailable", "Workspace is not active.");
    }
    return workspace;
  }

  const service: AgentLifecyclePersistence["agentDefinitions"] = {
    async list(invocation) {
      const page = await listEnvironmentRecords<AgentDefinition>(invocation, "agent-definition");
      return {
        items: page.items.map((record) => agentDefinitionSummaryResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const environment = await environmentFor(invocation);
      const workspace = invocation.body.workspaceId
        ? await activeWorkspace(environment, invocation.body.workspaceId)
        : undefined;
      const timestamp = now().toISOString();
      const record = definitionRecord({
        environment,
        manifest: invocation.body.manifest,
        principalId: id(invocation.identity.principalId),
        resourceId: id(await generateId()),
        timestamp,
        ...(workspace ? { workspaceId: workspace.data.id } : {}),
      });
      const releaseIndex = makeAgentDefinitionReleaseIndexRecord(record, timestamp);
      const event = await lifecycleEvent(invocation, {
        aggregateId: record.data.id,
        aggregateType: "agent-definition",
        aggregateVersion: 1,
        environmentId: record.data.environmentId,
        eventType: "agent-definition.created",
        occurredAt: timestamp,
        organizationId: record.data.organizationId,
        payload: { id: record.data.id, slug: record.data.slug, status: record.data.status },
        projectId: record.data.projectId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          [
            { kind: "put", record },
            { kind: "put", record: releaseIndex },
            acquireUniqueClaim(uniqueClaim(record, timestamp)),
            ...(workspace ? [requireActiveWorkspace(workspace)] : []),
          ],
          [event],
          makePersistenceTransactionToken(invocation, "agent-definition.create"),
        ),
        {
          code: "resource_conflict",
          message: workspace
            ? "Agent definition key is already in use, or the workspace is no longer active."
            : "Agent definition key is already in use.",
        },
      );
      return agentDefinitionResult(record.data);
    },
    async get(invocation) {
      const record = await getAgentRecord<AgentDefinition>(
        invocation,
        "agent-definition",
        "Agent definition",
      );
      return agentDefinitionResult(record.data);
    },
    async update(invocation) {
      const previous = await getAgentRecord<AgentDefinition>(
        invocation,
        "agent-definition",
        "Agent definition",
      );
      expectedVersion(previous.data.version, invocation.body.expectedVersion);
      if (previous.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "definition_archived",
          "Archived definitions cannot be updated.",
        );
      }
      const timestamp = now().toISOString();
      const next = updatedDefinition(previous, timestamp, {
        draft: structuredClone(invocation.body.manifest),
        name: invocation.body.manifest.metadata.name,
        slug: invocation.body.manifest.metadata.key,
      });
      const previousRequirement = uniqueClaimRequirements(previous)[0];
      const nextRequirement = uniqueClaimRequirements(next)[0];
      const operations: TransactionOperation[] = [
        { kind: "put", previousRecord: previous, record: next },
      ];
      if (
        previousRequirement &&
        nextRequirement &&
        (previousRequirement.namespace !== nextRequirement.namespace ||
          previousRequirement.value !== nextRequirement.value)
      ) {
        operations.push(
          releaseUniqueClaim(uniqueClaim(previous, previous.data.createdAt)),
          acquireUniqueClaim(uniqueClaim(next, timestamp)),
        );
      }
      const event = await lifecycleEvent(invocation, {
        aggregateId: next.data.id,
        aggregateType: "agent-definition",
        environmentId: next.data.environmentId,
        eventType: "agent-definition.updated",
        occurredAt: timestamp,
        organizationId: next.data.organizationId,
        payload: { id: next.data.id, slug: next.data.slug, status: next.data.status },
        projectId: next.data.projectId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          operations,
          [event],
          makePersistenceTransactionToken(invocation, "agent-definition.update"),
        ),
        {
          code: "version_conflict",
          message: "The resource version or agent definition key changed concurrently.",
        },
      );
      return agentDefinitionResult(next.data);
    },
    async archive(invocation) {
      const previous = await getAgentRecord<AgentDefinition>(
        invocation,
        "agent-definition",
        "Agent definition",
      );
      expectedVersion(previous.data.version, invocation.body.expectedVersion);
      // Archiving closes mutable authoring. Deployments pin immutable releases and have an
      // independent stop lifecycle, so definition archival must not implicitly stop them.
      const timestamp = now().toISOString();
      const next = updatedDefinition(previous, timestamp, { status: "archived" });
      const event = await lifecycleEvent(invocation, {
        aggregateId: next.data.id,
        aggregateType: "agent-definition",
        environmentId: next.data.environmentId,
        eventType: "agent-definition.archived",
        occurredAt: timestamp,
        organizationId: next.data.organizationId,
        payload: { id: next.data.id, slug: next.data.slug, status: next.data.status },
        projectId: next.data.projectId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          dependencies.database,
          [{ kind: "put", previousRecord: previous, record: next }],
          [event],
          makePersistenceTransactionToken(invocation, "agent-definition.archive"),
        ),
        { code: "version_conflict", message: "The resource version has changed." },
      );
      return agentDefinitionResult(next.data);
    },
  };
  return service;
}
