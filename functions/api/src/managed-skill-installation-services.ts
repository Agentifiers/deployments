import {
  type ArchiveManagedSkillResourceRequest,
  type InstallManagedSkillRequest,
} from "@deployments-ai/api-contract";
import {
  acquireUniqueClaim,
  key,
  ManagedSkillInstallationRecord,
  PersistenceError,
  releaseUniqueClaim,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  ControlResourceContext,
  ControlResourceServices,
  ManagedSkillInstallation,
} from "./control-resource-api.ts";
import {
  assertActive,
  assertVersion,
  databaseValue,
  getRecord,
  id,
  managedSkillInstallationClaim,
  managedSkillInstallationResponse,
  queryRecords,
  requireActiveAgentDefinition,
  requireActiveManagedSkillRelease,
  requiredId,
  tenantScope,
  transactionToken,
  versionConflict,
} from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

export function makeManagedSkillInstallationServices(context: ControlResourceContext) {
  const { database, dependencies, generateId, globalPartition, now, tenantEvent } = context;
  const service: ControlResourceServices["managedSkillInstallations"] = {
    list: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      const page = await queryRecords(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "managed-skill-installation",
        invocation,
      );
      return {
        items: page.items.map((record) =>
          managedSkillInstallationResponse(record as ManagedSkillInstallation),
        ),
        nextCursor: page.nextCursor,
      };
    },
    install: async (invocation: ApiInvocation<InstallManagedSkillRequest>) => {
      const scope = await tenantScope(dependencies, invocation, true);
      const release = await getRecord(
        database,
        globalPartition("managed-skill-release"),
        "managed-skill-release",
        id(invocation.body.managedSkillReleaseId, "Managed skill release"),
        "Managed skill release",
      );
      assertActive(release.data.status, "Managed skill release");
      const skill = await getRecord(
        database,
        globalPartition("managed-skill"),
        "managed-skill",
        id(invocation.body.managedSkillId, "Managed skill"),
        "Managed skill",
      );
      if (skill.data.releaseId !== release.data.id) {
        throw new PersistenceError(
          "unprocessable",
          "managed_skill_release_mismatch",
          "Managed skill does not belong to the requested release.",
        );
      }
      const agentDefinition = invocation.body.agentDefinitionId
        ? await getRecord(
            database,
            key("ORG", scope.organizationId, "ENV", scope.environmentId),
            "agent-definition",
            id(invocation.body.agentDefinitionId, "Agent definition"),
            "Agent definition",
          )
        : undefined;
      if (agentDefinition) assertActive(agentDefinition.data.status, "Agent definition");
      const timestamp = now().toISOString();
      const record = Schema.decodeUnknownSync(ManagedSkillInstallationRecord)(
        withCanonicalRecordKeys({
          data: {
            ...scope,
            ...(invocation.body.agentDefinitionId
              ? { agentDefinitionId: id(invocation.body.agentDefinitionId, "Agent definition") }
              : {}),
            createdAt: timestamp,
            id: await generateId(),
            installedByPrincipalId: id(invocation.identity.principalId, "Principal"),
            managedSkillId: skill.data.id,
            managedSkillReleaseId: release.data.id,
            status: "active",
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "managed-skill-installation",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [
            requireActiveManagedSkillRelease(release),
            ...(agentDefinition ? [requireActiveAgentDefinition(agentDefinition)] : []),
            { kind: "put", record },
            acquireUniqueClaim(managedSkillInstallationClaim(record)),
          ],
          [
            await tenantEvent(invocation, record, "managed-skill-installation.created", timestamp, {
              id: record.data.id,
              managedSkillId: record.data.managedSkillId,
              managedSkillReleaseId: record.data.managedSkillReleaseId,
              status: record.data.status,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        {
          code: "managed_skill_install_conflict",
          kind: "conflict",
          message: "Managed skill release or agent definition is no longer active.",
        },
      );
      return managedSkillInstallationResponse(record);
    },
    get: async (invocation) => {
      const scope = await tenantScope(dependencies, invocation);
      return managedSkillInstallationResponse(
        await getRecord(
          database,
          key("ORG", scope.organizationId, "ENV", scope.environmentId),
          "managed-skill-installation",
          requiredId(invocation, "Managed skill installation"),
          "Managed skill installation",
        ),
      );
    },
    remove: async (invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>) => {
      const scope = await tenantScope(dependencies, invocation);
      const prior = await getRecord(
        database,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "managed-skill-installation",
        requiredId(invocation, "Managed skill installation"),
        "Managed skill installation",
      );
      assertVersion(
        prior.data.version,
        invocation.body.expectedVersion,
        "Managed skill installation",
      );
      assertActive(prior.data.status, "Managed skill installation");
      const timestamp = now().toISOString();
      const next = Schema.decodeUnknownSync(ManagedSkillInstallationRecord)(
        withCanonicalRecordKeys({
          data: {
            ...prior.data,
            status: "removed",
            updatedAt: timestamp,
            version: prior.data.version + 1,
          },
          itemType: "managed-skill-installation",
        }),
      );
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [
            { kind: "put", previousRecord: prior, record: next },
            releaseUniqueClaim(managedSkillInstallationClaim(prior)),
          ],
          [
            await tenantEvent(invocation, next, "managed-skill-installation.deleted", timestamp, {
              id: next.data.id,
              managedSkillId: next.data.managedSkillId,
              managedSkillReleaseId: next.data.managedSkillReleaseId,
              status: next.data.status,
            }),
          ],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Managed skill installation"),
      );
      return managedSkillInstallationResponse(next);
    },
  };
  return service;
}
