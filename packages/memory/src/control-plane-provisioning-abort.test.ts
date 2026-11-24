import { describe, expect, it } from "bun:test";
import {
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeMemorySearchProvisioningAbort } from "./control-plane-provisioning-abort.ts";
import { databaseFixture } from "./erasure-test-fixtures.ts";
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

function abortFixture() {
  let currentTime = new Date(timestamp);
  let purges = 0;
  const fixture = databaseFixture();
  const database = {
    ...fixture.database,
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      await fixture.database.transactWrite(operations);
      currentTime = new Date(currentTime.getTime() + 20_000);
    },
  } as DynamoDatabaseService;
  const put = (value: PlatformRecord) => fixture.apply([{ kind: "put", record: value }]);
  put(
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
  );
  put(
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
  );
  put(
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
  );
  put(
    record("memory-provider-mutation-gate", {
      createdAt: timestamp,
      drainEpoch: 0,
      organizationId: ids.organization,
      status: "open",
      targetId: ids.run,
      updatedAt: timestamp,
      version: 1,
    }),
  );
  put(
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
  );
  put(
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
  );
  const abort = makeMemorySearchProvisioningAbort(
    {
      database,
      generateId: async () => ids.thread,
      membershipDigest: async () => ({ digest: ids.run, keyVersion: 1 }),
      now: () => currentTime,
      registry: {
        resolve: async () =>
          ({
            providerId: "aws-native",
            purgeOrganization: async () => {
              purges += 1;
              return { deleted: true, receipt: { absenceVerified: true } };
            },
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
    find: (itemType: PlatformRecord["itemType"]) =>
      fixture.records().find((value) => value.itemType === itemType),
    put,
    purges: () => purges,
  };
}

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => "resolved",
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );

describe("memory search provisioning abort", () => {
  it("purges a failed candidate before restoring unconfigured placement", async () => {
    const { abort, advance, find, purges } = abortFixture();

    expect(
      await refusal(abort(ids.organization, { actionGeneration: 0, operationId: ids.memory })),
    ).toBe("Placement has no abortable provisioning target.");
    expect(
      await refusal(abort(ids.organization, { actionGeneration: 1, operationId: ids.toolCall })),
    ).toBe("Provisioning operation is missing or stale.");
    expect(purges()).toBe(0);

    expect(await refusal(abort(ids.organization))).toBe(
      "Memory provider mutations are draining; provisioning abort remains pending.",
    );
    expect(find("memory-search-provisioning")).toMatchObject({
      data: { nextAction: "abort-provisioning", phase: "aborting", status: "pending" },
    });
    advance(17 * 60_000);
    expect(await abort(ids.organization)).toMatchObject({
      data: { phase: "unconfigured", writeTargets: [] },
    });
    expect(purges()).toBe(1);
    expect(find("memory-search-provisioning")).toMatchObject({
      data: { phase: "aborted", status: "aborted" },
    });
    expect(find("memory-search-evidence-manifest")).toMatchObject({ data: { status: "clean" } });
    expect(find("memory-provider-mutation-gate")).toBeUndefined();
    expect(find("memory-search-target-record")).toBeUndefined();
    expect(find("semantic-event")).toMatchObject({
      data: {
        aggregateVersion: 2,
        eventType: "memory.search-placement.provisioning-aborted",
      },
    });
  });

  it("finishes an abort whose target directory compaction spans attempts", async () => {
    const { abort, advance, find, purges, put } = abortFixture();
    for (let index = 0; index < 300; index += 1) {
      put(
        record("memory-search-target-record", {
          createdAt: timestamp,
          organizationId: ids.organization,
          recordItemType: "memory-index-job",
          recordPk: `RUN#${ids.run}`,
          recordSk: `JOB#${index}`,
          recordTable: "execution",
          targetId: ids.run,
          updatedAt: timestamp,
          version: 0,
        }),
      );
    }

    expect(await refusal(abort(ids.organization))).toBe(
      "Memory provider mutations are draining; provisioning abort remains pending.",
    );
    advance(17 * 60_000);
    expect(await refusal(abort(ids.organization))).toBe(
      "Memory search target compaction remains pending.",
    );
    const afterFirstPages = {
      gate: find("memory-provider-mutation-gate")?.data,
      placement: find("memory-search-placement")?.data,
      provisioning: find("memory-search-provisioning")?.data,
    };
    expect(await abort(ids.organization)).toMatchObject({ data: { phase: "unconfigured" } });

    expect({
      afterFirstPages,
      directory: find("memory-search-target-record"),
      gate: find("memory-provider-mutation-gate"),
      provisioning: find("memory-search-provisioning")?.data,
      purges: purges(),
    }).toMatchObject({
      afterFirstPages: {
        gate: { status: "closed" },
        placement: { candidateTarget: target, phase: "provisioning" },
        provisioning: { nextAction: "abort-provisioning", phase: "aborting", status: "pending" },
      },
      directory: undefined,
      gate: undefined,
      provisioning: { phase: "aborted", status: "aborted" },
      purges: 1,
    });
  });
});
