import type {
  ControlResourceContext,
  ControlResourceServices,
  ManagedSkill,
} from "./control-resource-api.ts";
import {
  getRecord,
  managedSkillResponse,
  queryRecords,
  requiredId,
} from "./control-resource-api.ts";

export function makeManagedSkillServices(context: ControlResourceContext) {
  const { database, globalPartition } = context;
  const service: ControlResourceServices["managedSkills"] = {
    list: async (invocation) => {
      const releaseId = requiredId(invocation, "Managed skill release");
      await getRecord(
        database,
        globalPartition("managed-skill-release"),
        "managed-skill-release",
        releaseId,
        "Managed skill release",
      );
      const page = await queryRecords(
        database,
        globalPartition("managed-skill"),
        "managed-skill",
        invocation,
        (record) => record.itemType === "managed-skill" && record.data.releaseId === releaseId,
        `managed-skill-release:${releaseId}`,
      );
      return {
        items: page.items.map((record) => managedSkillResponse(record as ManagedSkill)),
        nextCursor: page.nextCursor,
      };
    },
    get: async (invocation) =>
      managedSkillResponse(
        await getRecord(
          database,
          globalPartition("managed-skill"),
          "managed-skill",
          requiredId(invocation, "Managed skill"),
          "Managed skill",
        ),
      ),
  };
  return service;
}
