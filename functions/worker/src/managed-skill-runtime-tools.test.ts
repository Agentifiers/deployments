import { describe, expect, test } from "bun:test";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { createRuntimeManagedSkillBuiltinExecutors } from "./managed-skill-runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "managed-skill-test",
  inputSummary: "test",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "managed_skills.reference.read",
};
const sourceId = id("10");
const releaseId = id("11");
const skillId = id("12");
const installationId = id("13");
const input = {
  path: "references/checklist.md",
  releaseId,
  skillKey: "release",
  sourceKey: "operations",
};

function rawRecord(itemType: PlatformRecord["itemType"], data: Record<string, unknown>) {
  return { data, itemType, pk: "test", sk: "test" } as unknown as PlatformRecord;
}

function records(installedAgentDefinitionId?: Ulid) {
  const source = rawRecord("managed-skill-source", {
    id: sourceId,
    key: "operations",
    status: "active",
  });
  const release = rawRecord("managed-skill-release", {
    id: releaseId,
    skillIdsByKey: { release: skillId },
    sourceId,
    status: "active",
  });
  const skill = rawRecord("managed-skill", {
    id: skillId,
    key: "release",
    references: { "references/checklist.md": "verify\ndeploy\n" },
    releaseId,
    sourceId,
  });
  const installation = rawRecord("managed-skill-installation", {
    ...(installedAgentDefinitionId ? { agentDefinitionId: installedAgentDefinitionId } : {}),
    environmentId: request.environmentId,
    id: installationId,
    managedSkillId: skillId,
    managedSkillReleaseId: releaseId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    status: "active",
  });
  const claim = rawRecord("unique-claim", {
    namespace: `environment:${request.environmentId}:managed-skill-installation`,
    ownerId: installationId,
    ownerItemType: "managed-skill-installation",
    ownerPk: installation.pk,
    ownerSk: installation.sk,
    ownerTable: "control",
    value: `${installedAgentDefinitionId ? `agent:${installedAgentDefinitionId}` : "environment"}:${skillId}`,
  });
  return { claim, installation, release, skill, source };
}

function database(installedAgentDefinitionId?: Ulid) {
  const seeded = records(installedAgentDefinitionId);
  const gets: { readonly pk: string; readonly sk: string }[] = [];
  const db: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: (_table, recordKey) => {
      gets.push(recordKey);
      let record: PlatformRecord | undefined;
      if (recordKey.sk === key("MANAGED-SKILL-SOURCE", sourceId)) record = seeded.source;
      if (recordKey.sk === key("MANAGED-SKILL-RELEASE", releaseId)) record = seeded.release;
      if (recordKey.sk === key("MANAGED-SKILL", skillId)) record = seeded.skill;
      if (recordKey.pk.startsWith("UNIQUE#")) record = seeded.claim;
      if (recordKey.pk === seeded.installation.pk && recordKey.sk === seeded.installation.sk) {
        record = seeded.installation;
      }
      return Promise.resolve(record);
    },
    putRecord: async () => {},
    queryRecords: () => Promise.reject(new Error("managed-skill reads must not use a GSI")),
    transactWrite: async () => {},
  };
  return { db, gets };
}

describe("managed-skill reference executor", () => {
  test("uses strong skill and uniqueness-claim reads without GSI propagation races", async () => {
    const store = database();
    const result = await createRuntimeManagedSkillBuiltinExecutors(store.db)[
      "managed_skills.reference.read"
    ]({ ...request, input }, {} as never);

    expect(result.artifacts?.[0]).toMatchObject({
      content: "verify\ndeploy\n",
      fileName: "checklist.md",
    });
    expect(store.gets).toContainEqual({
      pk: key("GLOBAL", "managed-skill"),
      sk: key("MANAGED-SKILL", skillId),
    });
    expect(store.gets.some((value) => value.pk.startsWith("UNIQUE#"))).toBe(true);
  });

  test("does not accept an installation granted to another agent", async () => {
    const store = database(id("19"));
    expect(
      createRuntimeManagedSkillBuiltinExecutors(store.db)["managed_skills.reference.read"](
        { ...request, input },
        {} as never,
      ),
    ).rejects.toThrow("not installed");
  });
});
