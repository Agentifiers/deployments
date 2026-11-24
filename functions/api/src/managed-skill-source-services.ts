import {
  type ArchiveManagedSkillResourceRequest,
  type CreateManagedSkillSourceRequest,
  type UpdateManagedSkillSourceRequest,
} from "@deployments-ai/api-contract";
import {
  ManagedSkillSourceRecord,
  acquireUniqueClaim,
  withCanonicalRecordKeys,
  apiPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  ControlResourceContext,
  ControlResourceServices,
  ManagedSkillSource,
} from "./control-resource-api.ts";
import {
  assertActive,
  assertVersion,
  databaseValue,
  getRecord,
  managedSkillSourceClaim,
  managedSkillSourceResponse,
  queryRecords,
  requiredId,
  transactionToken,
  versionConflict,
} from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

export function makeManagedSkillSourceServices(context: ControlResourceContext) {
  const { database, generateId, globalPartition, now } = context;
  const service: ControlResourceServices["managedSkillSources"] = {
    list: async (invocation) => {
      const page = await queryRecords(
        database,
        globalPartition("managed-skill-source"),
        "managed-skill-source",
        invocation,
      );
      return {
        items: page.items.map((record) => managedSkillSourceResponse(record as ManagedSkillSource)),
        nextCursor: page.nextCursor,
      };
    },
    create: async (invocation: ApiInvocation<CreateManagedSkillSourceRequest>) => {
      const timestamp = now().toISOString();
      const record = Schema.decodeUnknownSync(ManagedSkillSourceRecord)(
        withCanonicalRecordKeys({
          data: {
            ...invocation.body,
            createdAt: timestamp,
            id: await generateId(),
            status: "active",
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "managed-skill-source",
        }),
      );
      await databaseValue(
        apiPersistence.commit(
          database,
          [{ kind: "put", record }, acquireUniqueClaim(managedSkillSourceClaim(record))],
          transactionToken(invocation),
        ),
        undefined,
        {
          code: "managed_skill_source_key_conflict",
          kind: "conflict",
          message: "An active managed skill source already uses this key.",
        },
      );
      return managedSkillSourceResponse(record);
    },
    get: async (invocation) =>
      managedSkillSourceResponse(
        await getRecord(
          database,
          globalPartition("managed-skill-source"),
          "managed-skill-source",
          requiredId(invocation, "Managed skill source"),
          "Managed skill source",
        ),
      ),
    update: async (invocation: ApiInvocation<UpdateManagedSkillSourceRequest>) => {
      const prior = await getRecord(
        database,
        globalPartition("managed-skill-source"),
        "managed-skill-source",
        requiredId(invocation, "Managed skill source"),
        "Managed skill source",
      );
      assertActive(prior.data.status, "Managed skill source");
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Managed skill source");
      const clearedFields = new Set(
        ["licenseHash", "metadata", "pinnedCommit", "repositoryUrl"].filter(
          (field) => invocation.body[field as keyof UpdateManagedSkillSourceRequest] === null,
        ),
      );
      const retained = Object.fromEntries(
        Object.entries(prior.data).filter(([field]) => !clearedFields.has(field)),
      );
      const updates = Object.fromEntries(
        Object.entries(invocation.body).filter(
          ([field, value]) => field !== "expectedVersion" && value !== null,
        ),
      );
      const next = Schema.decodeUnknownSync(ManagedSkillSourceRecord)(
        withCanonicalRecordKeys({
          data: {
            ...retained,
            ...updates,
            updatedAt: now().toISOString(),
            version: prior.data.version + 1,
          },
          itemType: "managed-skill-source",
        }),
      );
      await databaseValue(
        apiPersistence.commit(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Managed skill source"),
      );
      return managedSkillSourceResponse(next);
    },
    archive: async (invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>) => {
      const prior = await getRecord(
        database,
        globalPartition("managed-skill-source"),
        "managed-skill-source",
        requiredId(invocation, "Managed skill source"),
        "Managed skill source",
      );
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Managed skill source");
      const next = Schema.decodeUnknownSync(ManagedSkillSourceRecord)(
        withCanonicalRecordKeys({
          data: {
            ...prior.data,
            status: "archived",
            updatedAt: now().toISOString(),
            version: prior.data.version + 1,
          },
          itemType: "managed-skill-source",
        }),
      );
      await databaseValue(
        apiPersistence.commit(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Managed skill source"),
      );
      return managedSkillSourceResponse(next);
    },
  };
  return service;
}
