import { describe, expect, it } from "bun:test";
import {
  makeDynamoDatabase,
  tableForItemType,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { makeMemorySearchProvisioningAbort } from "./control-plane-provisioning-abort.ts";
import { memorySearchMembershipShard } from "./membership.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids } from "./test-fixtures.ts";

const timestamp = "2026-07-28T12:00:00.000Z";
const target: MemorySearchTarget = {
  componentIds: [ids.space],
  embeddingProfileId: ids.agent,
  location: { region: "aws-us-east-2" },
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: ids.run,
};
const record = (itemType: string, data: Readonly<Record<string, unknown>>) =>
  withCanonicalRecordKeys({ data, itemType } as never) as unknown as PlatformRecord;

/**
 * A provisioning operation at event version 1 whose `memory.search-placement.provisioning-requested`
 * event retention has deleted, stored in the fake DynamoDB behind the real transaction validation.
 */
function provisioningWithExpiredEvents() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const seeded of [
    record("organization", {
      createdAt: timestamp,
      id: ids.organization,
      name: "Acme",
      slug: "acme",
      status: "active",
      updatedAt: timestamp,
      version: 1,
    }),
    record("memory-search-placement", {
      candidateTarget: target,
      createdAt: timestamp,
      generation: 1,
      operationId: ids.toolCall,
      organizationId: ids.organization,
      phase: "provisioning",
      updatedAt: timestamp,
      version: 1,
      writeTargets: [],
    }),
    record("memory-search-provisioning", {
      actionGeneration: 0,
      createdAt: timestamp,
      evidenceManifestId: ids.memory2,
      eventVersion: 1,
      id: ids.toolCall,
      nextAction: "provision-components",
      nextActionAt: timestamp,
      operationShard: 0,
      organizationId: ids.organization,
      phase: "requested",
      placementGeneration: 1,
      status: "pending",
      target,
      updatedAt: timestamp,
      version: 7,
    }),
    record("memory-search-evidence-manifest", {
      componentLocations: [{ componentId: ids.space }],
      createdAt: timestamp,
      evidenceKeys: ["evidence"],
      id: ids.memory2,
      operationId: ids.toolCall,
      organizationId: ids.organization,
      status: "manifested",
      targetId: ids.run,
      updatedAt: timestamp,
      version: 0,
    }),
    record("memory-provider-mutation-gate", {
      createdAt: timestamp,
      drainEpoch: 0,
      organizationId: ids.organization,
      status: "open",
      targetId: ids.run,
      updatedAt: timestamp,
      version: 1,
    }),
    record("memory-search-component", {
      componentKind: "namespace",
      createdAt: timestamp,
      generationId: ids.memory,
      id: ids.space,
      location: target.location,
      providerId: "aws-native",
      schemaGeneration: 1,
      status: "active",
      updatedAt: timestamp,
      version: 0,
    }),
    record("memory-search-generation-target", {
      createdAt: timestamp,
      generationId: ids.memory,
      keyVersion: 1,
      membershipShard: memorySearchMembershipShard(ids.run),
      providerId: "aws-native",
      targetDigest: ids.run,
      updatedAt: timestamp,
      version: 0,
    }),
  ]) {
    fake.put(tableForItemType(seeded.itemType), seeded);
  }
  let currentTime = new Date(timestamp);
  const abort = makeMemorySearchProvisioningAbort(
    {
      database: makeDynamoDatabase(fake.client, tables),
      generateId: async () => ids.thread,
      membershipDigest: async () => ({ digest: ids.run, keyVersion: 1 }),
      now: () => currentTime,
      registry: {
        resolve: async () =>
          ({
            providerId: "aws-native",
            purgeOrganization: async () => ({
              deleted: true,
              receipt: { absenceVerified: true },
            }),
            target,
          }) as never,
      },
    },
    { live: async () => [], remove: async () => [] },
  );
  return {
    abort,
    advance: (milliseconds: number) => {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    eventKeys: () => fake.items(tables.events).map((item) => item.sk),
    provisioning: () =>
      fake.items(tables.control).find((item) => item.itemType === "memory-search-provisioning")
        ?.data,
  };
}

describe("memory search provisioning abort after retention", () => {
  it("aborts an operation whose provisioning-requested event retention deleted", async () => {
    const { abort, advance, eventKeys, provisioning } = provisioningWithExpiredEvents();

    const draining = await abort(ids.organization).then(
      () => "resolved",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    advance(17 * 60_000);
    const placement = await abort(ids.organization);

    expect(draining).toBe(
      "Memory provider mutations are draining; provisioning abort remains pending.",
    );

    expect(placement.data.phase).toBe("unconfigured");
    expect(provisioning()).toMatchObject({ phase: "aborted", status: "aborted" });
    expect(eventKeys()).toEqual(["SEMANTIC-EVENT#0000000000000002"]);
  });
});
