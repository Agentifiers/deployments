import {
  key,
  managedSkillInstallationClaimNamespace,
  managedSkillInstallationClaimValue,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import { MANAGED_SKILL_REFERENCE_READ_MAX_BYTES } from "@deployments-ai/tools";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  optionalInteger,
  requiredString,
  textToolResult,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";

type ManagedSkill = Extract<PlatformRecord, { readonly itemType: "managed-skill" }>;

async function globalRecord<
  Type extends "managed-skill" | "managed-skill-release" | "managed-skill-source",
>(
  database: DynamoDatabaseService,
  itemType: Type,
  id: Ulid,
): Promise<Extract<PlatformRecord, { readonly itemType: Type }> | undefined> {
  const record = await workerPersistence.read(
    database,
    "control",
    {
      pk: key("GLOBAL", itemType),
      sk: key(itemType.toUpperCase(), id),
    },
    true,
  );
  return record?.itemType === itemType
    ? (record as Extract<PlatformRecord, { readonly itemType: Type }>)
    : undefined;
}

async function installedSkill(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  releaseId: Ulid,
  skillId: Ulid,
  skillKey: string,
): Promise<ManagedSkill | undefined> {
  const skill = await workerPersistence.read(
    database,
    "control",
    {
      pk: key("GLOBAL", "managed-skill"),
      sk: key("MANAGED-SKILL", skillId),
    },
    true,
  );
  if (
    skill?.itemType !== "managed-skill" ||
    skill.data.id !== skillId ||
    skill.data.releaseId !== releaseId ||
    skill.data.key !== skillKey
  ) {
    return undefined;
  }

  const namespace = managedSkillInstallationClaimNamespace(request.environmentId);
  for (const agentDefinitionId of [request.agentDefinitionId, undefined]) {
    const value = managedSkillInstallationClaimValue(agentDefinitionId, skill.data.id);
    const claim = await workerPersistence.read(
      database,
      "control",
      { pk: key("UNIQUE", namespace), sk: key("VALUE", value) },
      true,
    );
    if (
      claim?.itemType !== "unique-claim" ||
      claim.data.namespace !== namespace ||
      claim.data.value !== value ||
      claim.data.ownerItemType !== "managed-skill-installation" ||
      claim.data.ownerTable !== "control"
    ) {
      continue;
    }
    const installation = await workerPersistence.read(
      database,
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
    if (
      installation?.itemType === "managed-skill-installation" &&
      installation.data.id === claim.data.ownerId &&
      installation.data.organizationId === request.organizationId &&
      installation.data.projectId === request.projectId &&
      installation.data.environmentId === request.environmentId &&
      installation.data.status === "active" &&
      installation.data.managedSkillId === skill.data.id &&
      installation.data.managedSkillReleaseId === releaseId &&
      installation.data.agentDefinitionId === agentDefinitionId
    ) {
      return skill;
    }
  }
  return undefined;
}

function referencePath(value: string) {
  if (
    value.length > 512 ||
    !/^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("path must be a normalized relative path below references/.");
  }
  return value;
}

export function createRuntimeManagedSkillBuiltinExecutors(
  database: DynamoDatabaseService,
): Readonly<Record<"managed_skills.reference.read", ExecuteRuntimeBuiltinTool>> {
  return {
    "managed_skills.reference.read": async (request) => {
      const input = toolInput(request.input ?? {});
      const sourceKey = requiredString(input, "sourceKey", 128);
      const skillKey = requiredString(input, "skillKey", 128);
      const releaseId = ulid(input.releaseId, "releaseId");
      const path = referencePath(requiredString(input, "path", 512));
      const maximum =
        optionalInteger(input, "maxBytes", {
          maximum: MANAGED_SKILL_REFERENCE_READ_MAX_BYTES,
          minimum: 0,
        }) ?? MANAGED_SKILL_REFERENCE_READ_MAX_BYTES;
      const release = await globalRecord(database, "managed-skill-release", releaseId);
      const source = release
        ? await globalRecord(database, "managed-skill-source", release.data.sourceId)
        : undefined;
      if (
        !source ||
        !release ||
        source.data.key !== sourceKey ||
        source.data.status !== "active" ||
        release.data.status !== "active"
      ) {
        throw new TypeError("The requested managed skill release was not found or is inactive.");
      }
      const skillId = release.data.skillIdsByKey[skillKey];
      const skill = skillId
        ? await installedSkill(database, request, release.data.id, skillId, skillKey)
        : undefined;
      if (!skill || skill.data.sourceId !== source.data.id) {
        throw new TypeError("The requested managed skill is not installed for the current agent.");
      }
      const content = skill.data.references?.[path];
      if (typeof content !== "string")
        throw new TypeError("The requested reference path was not found.");
      const bytes = new TextEncoder().encode(content).byteLength;
      if (bytes > maximum) {
        throw new TypeError(
          `The requested reference is ${bytes} bytes and exceeds maxBytes ${maximum}.`,
        );
      }
      return textToolResult({
        content,
        fileName: path.split("/").at(-1)!,
        label: `${sourceKey}/${skillKey}/${path}`,
        summary: `Read managed-skill reference ${path} (${bytes} bytes).`,
        type: "report",
        visibility: "private",
      });
    },
  };
}
