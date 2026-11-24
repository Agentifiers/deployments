import {
  type ArchiveWorkflowResourceRequest,
  type PublishWorkflowReleaseRequest,
} from "@deployments-ai/api-contract";
import {
  WorkflowDefinitionRecord,
  WorkflowReleaseRecord,
  workflowDefinitionContentHash,
  key,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  ControlResourceContext,
  ControlResourceServices,
  WorkflowRelease,
} from "./control-resource-api.ts";
import {
  assertActive,
  assertVersion,
  databaseValue,
  getRecord,
  id,
  queryRecords,
  requiredId,
  tenantScope,
  transactionToken,
  versionConflict,
  workflowReleaseResponse,
  workflowReleaseSummary,
} from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

export function makeWorkflowReleaseServices(context: ControlResourceContext) {
  const { database, dependencies, generateId, now, tenantEvent } = context;
  const service: ControlResourceServices["workflowReleases"] = {
    list: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      const definitionId = requiredId(invocation, "Workflow definition");
      await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-definition",
        definitionId,
        "Workflow definition",
      );
      const page = await queryRecords(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-release",
        invocation,
        (record) =>
          record.itemType === "workflow-release" &&
          record.data.workflowDefinitionId === definitionId,
        `workflow-definition:${definitionId}`,
      );
      return {
        items: page.items.map((record) => workflowReleaseSummary(record as WorkflowRelease)),
        nextCursor: page.nextCursor,
      };
    },
    publish: async (invocation: ApiInvocation<PublishWorkflowReleaseRequest>) => {
      const scope = await tenantScope(dependencies, invocation, true);
      const definitionId = requiredId(invocation, "Workflow definition");
      const definition = await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-definition",
        definitionId,
        "Workflow definition",
      );
      assertActive(definition.data.status, "Workflow definition");
      assertVersion(
        definition.data.version,
        invocation.body.expectedDefinitionVersion,
        "Workflow definition",
      );
      const releaseNumber = (definition.data.lastReleaseNumber ?? 0) + 1;
      const timestamp = now().toISOString();
      const release = Schema.decodeUnknownSync(WorkflowReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            ...scope,
            contentHash: workflowDefinitionContentHash(definition.data.draft),
            createdAt: timestamp,
            createdByPrincipalId: id(invocation.identity.principalId, "Principal"),
            definition: definition.data.draft,
            id: await generateId(),
            releaseNumber,
            status: "active",
            version: 0,
            workflowDefinitionId: definitionId,
          },
          itemType: "workflow-release",
        }),
      );
      const updatedDefinition = Schema.decodeUnknownSync(WorkflowDefinitionRecord)(
        withCanonicalRecordKeys({
          data: {
            ...definition.data,
            lastReleaseNumber: releaseNumber,
            updatedAt: timestamp,
            version: definition.data.version + 1,
          },
          itemType: "workflow-definition",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [
            { kind: "put", previousRecord: definition, record: updatedDefinition },
            { kind: "put", record: release },
          ],
          [
            await tenantEvent(
              invocation,
              updatedDefinition,
              "workflow-definition.release-published",
              timestamp,
              {
                id: updatedDefinition.data.id,
                lastReleaseNumber: releaseNumber,
                status: updatedDefinition.data.status,
              },
            ),
            await tenantEvent(invocation, release, "workflow-release.published", timestamp, {
              contentHash: release.data.contentHash,
              id: release.data.id,
              releaseNumber: release.data.releaseNumber,
              status: release.data.status,
              workflowDefinitionId: release.data.workflowDefinitionId,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Workflow definition"),
      );
      return workflowReleaseResponse(release);
    },
    get: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      return workflowReleaseResponse(
        await getRecord(
          database,
          key("ORG", scope.organizationId, "ENV", scope.environmentId),
          "workflow-release",
          requiredId(invocation, "Workflow release"),
          "Workflow release",
        ),
      );
    },
    archive: async (invocation: ApiInvocation<ArchiveWorkflowResourceRequest>) => {
      const scope = await tenantScope(dependencies, invocation);
      const prior = await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-release",
        requiredId(invocation, "Workflow release"),
        "Workflow release",
      );
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Workflow release");
      const timestamp = now().toISOString();
      const next = Schema.decodeUnknownSync(WorkflowReleaseRecord)(
        withCanonicalRecordKeys({
          data: { ...prior.data, status: "archived", version: prior.data.version + 1 },
          itemType: "workflow-release",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          [
            await tenantEvent(invocation, next, "workflow-release.archived", timestamp, {
              contentHash: next.data.contentHash,
              id: next.data.id,
              releaseNumber: next.data.releaseNumber,
              status: next.data.status,
              workflowDefinitionId: next.data.workflowDefinitionId,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Workflow release"),
      );
      return workflowReleaseResponse(next);
    },
  };
  return service;
}
