import {
  type ArchiveManagedSkillResourceRequest,
  type PublishManagedSkillReleaseRequest,
} from "@deployments-ai/api-contract";
import {
  ManagedSkillRecord,
  ManagedSkillReleaseRecord,
  ManagedSkillSourceRecord,
  PersistenceError,
  acquireUniqueClaim,
  withCanonicalRecordKeys,
  apiPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type {
  ControlResourceContext,
  ControlResourceServices,
  ManagedSkillRelease,
} from "./control-resource-api.ts";
import {
  assertActive,
  assertManagedSkillPersistenceSize,
  assertVersion,
  contentHash,
  databaseValue,
  getRecord,
  managedSkillReleaseClaim,
  managedSkillReleaseResponse,
  queryRecords,
  requiredId,
  transactionToken,
  versionConflict,
} from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

export function makeManagedSkillReleaseServices(context: ControlResourceContext) {
  const { database, generateId, globalPartition, now } = context;
  const service: ControlResourceServices["managedSkillReleases"] = {
    list: async (invocation) => {
      const sourceId = requiredId(invocation, "Managed skill source");
      await getRecord(
        database,
        globalPartition("managed-skill-source"),
        "managed-skill-source",
        sourceId,
        "Managed skill source",
      );
      const page = await queryRecords(
        database,
        globalPartition("managed-skill-release"),
        "managed-skill-release",
        invocation,
        (record) =>
          record.itemType === "managed-skill-release" && record.data.sourceId === sourceId,
        `managed-skill-source:${sourceId}`,
      );
      return {
        items: page.items.map((record) =>
          managedSkillReleaseResponse(record as ManagedSkillRelease),
        ),
        nextCursor: page.nextCursor,
      };
    },
    publish: async (invocation: ApiInvocation<PublishManagedSkillReleaseRequest>) => {
      const sourceId = requiredId(invocation, "Managed skill source");
      const source = await getRecord(
        database,
        globalPartition("managed-skill-source"),
        "managed-skill-source",
        sourceId,
        "Managed skill source",
      );
      assertActive(source.data.status, "Managed skill source");
      assertVersion(
        source.data.version,
        invocation.body.expectedSourceVersion,
        "Managed skill source",
      );
      const skillIds = await Promise.all(invocation.body.skills.map(() => generateId()));
      const idsByKey = new Map(
        invocation.body.skills.map((skill, index) => [skill.key, skillIds[index]!] as const),
      );
      for (const skill of invocation.body.skills) {
        for (const dependency of skill.dependencies ?? []) {
          if (!idsByKey.has(dependency)) {
            throw new PersistenceError(
              "unprocessable",
              "managed_skill_dependency_missing",
              `Managed skill ${skill.key} references missing dependency ${dependency}.`,
            );
          }
        }
      }
      const timestamp = now().toISOString();
      const releaseId = await generateId();
      const releasePayload = {
        manifest: invocation.body.manifest ?? {},
        releaseVersion: invocation.body.releaseVersion,
        skills: invocation.body.skills,
      };
      const release = Schema.decodeUnknownSync(ManagedSkillReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            activatedAt: timestamp,
            contentHash: contentHash(releasePayload),
            createdAt: timestamp,
            id: releaseId,
            manifest: invocation.body.manifest ?? {},
            releaseVersion: invocation.body.releaseVersion,
            skillIdsByKey: Object.fromEntries(idsByKey),
            skillCount: invocation.body.skills.length,
            sourceId,
            status: "active",
            version: 0,
          },
          itemType: "managed-skill-release",
        }),
      );
      const skills = invocation.body.skills.map((skill, index) =>
        Schema.decodeUnknownSync(ManagedSkillRecord)(
          withCanonicalRecordKeys({
            data: {
              contentText: skill.content,
              createdAt: timestamp,
              dependencies: (skill.dependencies ?? []).map(
                (dependency) => idsByKey.get(dependency)!,
              ),
              ...(skill.description ? { description: skill.description } : {}),
              id: skillIds[index]!,
              key: skill.key,
              ...(skill.metadata ? { metadata: skill.metadata } : {}),
              ...(skill.references ? { references: skill.references } : {}),
              releaseId,
              sourceId,
            },
            itemType: "managed-skill",
          }),
        ),
      );
      const updatedSource = Schema.decodeUnknownSync(ManagedSkillSourceRecord)(
        withCanonicalRecordKeys({
          data: {
            ...source.data,
            updatedAt: timestamp,
            version: source.data.version + 1,
          },
          itemType: "managed-skill-source",
        }),
      );
      const releaseClaim = managedSkillReleaseClaim(release);
      assertManagedSkillPersistenceSize([updatedSource, release, releaseClaim, ...skills]);
      await databaseValue(
        apiPersistence.commit(
          database,
          [
            { kind: "put", previousRecord: source, record: updatedSource },
            { kind: "put", record: release },
            acquireUniqueClaim(releaseClaim),
            ...skills.map((skill) => ({ kind: "put" as const, record: skill })),
          ],
          transactionToken(invocation),
        ),
        undefined,
        {
          code: "managed_skill_release_conflict",
          kind: "conflict",
          message: "Managed skill source version or releaseVersion changed concurrently.",
        },
      );
      return managedSkillReleaseResponse(release);
    },
    get: async (invocation) =>
      managedSkillReleaseResponse(
        await getRecord(
          database,
          globalPartition("managed-skill-release"),
          "managed-skill-release",
          requiredId(invocation, "Managed skill release"),
          "Managed skill release",
        ),
      ),
    archive: async (invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>) => {
      const prior = await getRecord(
        database,
        globalPartition("managed-skill-release"),
        "managed-skill-release",
        requiredId(invocation, "Managed skill release"),
        "Managed skill release",
      );
      assertVersion(prior.data.version, invocation.body.expectedVersion, "Managed skill release");
      const next = Schema.decodeUnknownSync(ManagedSkillReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            ...prior.data,
            archivedAt: now().toISOString(),
            status: "archived",
            version: prior.data.version + 1,
          },
          itemType: "managed-skill-release",
        }),
      );
      await databaseValue(
        apiPersistence.commit(
          database,
          [{ kind: "put", previousRecord: prior, record: next }],
          transactionToken(invocation),
        ),
        undefined,
        versionConflict("Managed skill release"),
      );
      return managedSkillReleaseResponse(next);
    },
  };
  return service;
}
