import {
  type ArchiveWorkflowResourceRequest,
  type CreateWorkflowDefinitionRequest,
  type UpdateWorkflowDefinitionRequest,
} from "@deployments-ai/api-contract";
import {
  WorkflowDefinitionRecord,
  key,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  ControlResourceContext,
  ControlResourceServices,
  WorkflowDefinition,
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
  workflowDefinitionResponse,
  workflowDefinitionSummary,
} from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

export function makeWorkflowDefinitionServices(context: ControlResourceContext) {
  const { database, dependencies, generateId, now, tenantEvent } = context;
  const service: ControlResourceServices["workflowDefinitions"] = {
    list: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      const page = await queryRecords(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-definition",
        invocation,
      );
      return {
        items: page.items.map((record) => workflowDefinitionSummary(record as WorkflowDefinition)),
        nextCursor: page.nextCursor,
      };
    },
    create: async (invocation: ApiInvocation<CreateWorkflowDefinitionRequest>) => {
      const scope = await tenantScope(dependencies, invocation, true);
      const timestamp = now().toISOString();
      const workflowId = await generateId();
      const definition = invocation.body.definition;
      const record = Schema.decodeUnknownSync(WorkflowDefinitionRecord)(
        withCanonicalRecordKeys({
          data: {
            ...scope,
            createdAt: timestamp,
            createdByPrincipalId: id(invocation.identity.principalId, "Principal"),
            draft: definition,
            id: workflowId,
            name: definition.name,
            slug: definition.slug,
            status: "active",
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "workflow-definition",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [{ kind: "put", record }],
          [
            await tenantEvent(invocation, record, "workflow-definition.created", timestamp, {
              id: record.data.id,
              name: record.data.name,
              slug: record.data.slug,
              status: record.data.status,
            }),
          ],
          transactionToken(invocation),
        ),
      );
      return workflowDefinitionResponse(record);
    },
    get: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      return workflowDefinitionResponse(
        await getRecord(
          database,
          key("ORG", scope.organizationId, "ENV", scope.environmentId),
          "workflow-definition",
          requiredId(invocation, "Workflow definition"),
          "Workflow definition",
        ),
      );
    },
    update: async (invocation: ApiInvocation<UpdateWorkflowDefinitionRequest>) => {
      const scope = await tenantScope(dependencies, invocation, true);
      const prior = await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-definition",
        requiredId(invocation, "Workflow definition"),
        "Workflow definition",
      );
      assertActive(prior.data.status, "Workflow definition");
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Workflow definition");
      const timestamp = now().toISOString();
      const next = Schema.decodeUnknownSync(WorkflowDefinitionRecord)(
        withCanonicalRecordKeys({
          data: {
            ...prior.data,
            draft: invocation.body.definition,
            name: invocation.body.definition.name,
            slug: invocation.body.definition.slug,
            updatedAt: timestamp,
            version: prior.data.version + 1,
          },
          itemType: "workflow-definition",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          [
            await tenantEvent(invocation, next, "workflow-definition.updated", timestamp, {
              id: next.data.id,
              name: next.data.name,
              slug: next.data.slug,
              status: next.data.status,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Workflow definition"),
      );
      return workflowDefinitionResponse(next);
    },
    archive: async (invocation: ApiInvocation<ArchiveWorkflowResourceRequest>) => {
      const scope = await tenantScope(dependencies, invocation);
      const prior = await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workflow-definition",
        requiredId(invocation, "Workflow definition"),
        "Workflow definition",
      );
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Workflow definition");
      const timestamp = now().toISOString();
      const next = Schema.decodeUnknownSync(WorkflowDefinitionRecord)(
        withCanonicalRecordKeys({
          data: {
            ...prior.data,
            status: "archived",
            updatedAt: timestamp,
            version: prior.data.version + 1,
          },
          itemType: "workflow-definition",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          [
            await tenantEvent(invocation, next, "workflow-definition.archived", timestamp, {
              id: next.data.id,
              name: next.data.name,
              slug: next.data.slug,
              status: next.data.status,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Workflow definition"),
      );
      return workflowDefinitionResponse(next);
    },
  };
  return service;
}
