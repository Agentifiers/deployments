import {
  HoldKey,
  makeOrganizationStandingRepository,
  MemorySearchPhysicalOwnerRecord,
  MemorySearchPlacementRecord,
  OrganizationRecord,
  readMemorySearchIndexDropReceipt,
  StandingActor,
  Ulid,
  withCanonicalRecordKeys,
  type HoldReason,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { physicalLocationHash } from "@deployments-ai/memory";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { dropDisabledOrganizationSearchIndex } from "./search-index-drop.ts";

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6006");
const OTHER_ORGANIZATION = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6007");
const OWN_TARGET = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6010");
const OTHER_TARGET = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6011");
const PROFILE = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6012");
const OWN_COMPONENT = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6013");
const OTHER_COMPONENT = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6014");
const OPERATION = decodeUlid("01ARZ3NDEKTSV4RRFFQ69G6015");
const ENDPOINT = "https://search.example.com";
const OWN_INDEX = "memory-01arz3ndektsv4rrffq69g6006-v1";
const OTHER_INDEX = "memory-01arz3ndektsv4rrffq69g6007-v1";
const CREATED = "2026-10-01T00:00:00.000Z";

const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G6020",
});
const BILLING = Schema.decodeUnknownSync(StandingActor)({ kind: "service", service: "billing" });

function location(index: string) {
  return {
    automatedSnapshotRetentionHours: 336,
    backupSafetyMarginMinutes: 60,
    embeddingDimensions: 8,
    openSearchEndpoint: ENDPOINT,
    openSearchIndex: index,
    region: "us-east-2",
  };
}

function target(targetId: Ulid, componentId: Ulid, index: string) {
  return {
    componentIds: [componentId],
    embeddingProfileId: PROFILE,
    location: location(index),
    providerId: "aws-native" as const,
    schemaGeneration: 3,
    targetId,
  };
}

function denseOwner(organizationId: Ulid, targetId: Ulid, componentId: Ulid, index: string) {
  return Schema.decodeUnknownSync(MemorySearchPhysicalOwnerRecord)(
    withCanonicalRecordKeys({
      data: {
        componentId,
        componentKind: "dense" as const,
        createdAt: CREATED,
        organizationId,
        physicalLocationHash: physicalLocationHash("dense", location(index)),
        referenceCount: 1,
        targetId,
        updatedAt: CREATED,
        version: 0,
      },
      itemType: "memory-search-physical-owner" as const,
    }),
  );
}

/**
 * An organization whose memory placement reads and writes its own index while migrating to a
 * candidate index that another organization owns.
 */
function installation(
  opensearch: { readonly missing?: boolean } = {},
  ownIndex: string = OWN_INDEX,
) {
  const own = target(OWN_TARGET, OWN_COMPONENT, ownIndex);
  const memory = evaluationMemoryDatabase([
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: CREATED,
          id: ORGANIZATION,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: CREATED,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
    Schema.decodeUnknownSync(MemorySearchPlacementRecord)(
      withCanonicalRecordKeys({
        data: {
          candidateTarget: target(OTHER_TARGET, OTHER_COMPONENT, OTHER_INDEX),
          createdAt: CREATED,
          generation: 2,
          operationId: OPERATION,
          organizationId: ORGANIZATION,
          phase: "active" as const,
          readTarget: own,
          updatedAt: CREATED,
          version: 2,
          writeTargets: [own],
        },
        itemType: "memory-search-placement" as const,
      }),
    ),
    denseOwner(ORGANIZATION, OWN_TARGET, OWN_COMPONENT, ownIndex),
    denseOwner(OTHER_ORGANIZATION, OTHER_TARGET, OTHER_COMPONENT, OTHER_INDEX),
  ]);
  const standing = makeOrganizationStandingRepository({
    database: memory.database,
    installDefaults: {
      operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
      tenantLimits: {
        activeSandboxes: 1,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 2,
      },
    },
    now: () => new Date("2026-10-20T09:00:00.000Z"),
  });
  const requests: { readonly method: string; readonly path: string }[] = [];
  return {
    drop: () =>
      dropDisabledOrganizationSearchIndex({
        approvedEndpoint: ENDPOINT,
        database: memory.database,
        now: () => new Date("2026-10-23T12:00:00.000Z"),
        openSearch: () => ({
          request: async ({ method, path }) => {
            requests.push({ method, path });
            if (opensearch.missing) {
              throw Object.assign(new Error("OpenSearch request failed with status 404."), {
                status: 404,
              });
            }
            return { acknowledged: true };
          },
        }),
        organizationId: ORGANIZATION,
        standing,
      }),
    hold: (source: "operator" | "service", key: string, reason: HoldReason) =>
      standing.placeHold({
        actor: source === "operator" ? OPERATOR : BILLING,
        customerMessage: "This organization is closed.",
        key: Schema.decodeUnknownSync(HoldKey)(key),
        organizationId: ORGANIZATION,
        reason,
      }),
    receipt: () => readMemorySearchIndexDropReceipt(memory.database, ORGANIZATION),
    requests,
  };
}

describe("dropping a disabled organization's memory search index", () => {
  test("refuses an active organization", async () => {
    const memory = installation();

    expect([await memory.drop(), memory.requests, await memory.receipt()]).toEqual([
      { outcome: "refused", reason: "organization-active" },
      [],
      undefined,
    ]);
  });

  test("refuses unless an operator hold stops the organization without preserving evidence", async () => {
    const draining = installation();
    await draining.hold("operator", "eval-closeout", "payment");
    const evidence = installation();
    await evidence.hold("operator", "eval-closeout", "manual");
    await evidence.hold("service", "abuse-review", "abuse");
    const serviceOnly = installation();
    await serviceOnly.hold("service", "eval-closeout", "manual");

    expect(
      await Promise.all(
        [draining, evidence, serviceOnly].map(async (memory) => [
          await memory.drop(),
          memory.requests,
          await memory.receipt(),
        ]),
      ),
    ).toEqual([
      [{ outcome: "refused", reason: "organization-draining" }, [], undefined],
      [{ outcome: "refused", reason: "evidence-preserved" }, [], undefined],
      [{ outcome: "refused", reason: "no-operator-hold" }, [], undefined],
    ]);
  });

  test("deletes only the organization's own index and keeps the one another organization owns", async () => {
    const memory = installation();
    await memory.hold("operator", "eval-closeout", "manual");

    const result = await memory.drop();

    expect([memory.requests, result.outcome === "dropped" ? result.kept : result]).toEqual([
      [{ method: "DELETE", path: `/${OWN_INDEX}` }],
      [{ index: OTHER_INDEX, reason: "owned-by-another-organization" }],
    ]);
  });

  test("records which operator hold authorized the drop", async () => {
    const memory = installation();
    await memory.hold("operator", "eval-closeout", "manual");

    await memory.drop();

    expect((await memory.receipt())?.data).toEqual({
      createdAt: "2026-10-23T12:00:00.000Z",
      droppedAt: "2026-10-23T12:00:00.000Z",
      indexes: [OWN_INDEX],
      operatorHold: {
        id: "operator/eval-closeout",
        placedAt: "2026-10-20T09:00:00.000Z",
        reason: "manual",
      },
      organizationId: ORGANIZATION,
      updatedAt: "2026-10-23T12:00:00.000Z",
      version: 0,
    });
  });

  test("a second drop answers from the receipt without touching OpenSearch", async () => {
    const memory = installation();
    await memory.hold("operator", "eval-closeout", "manual");
    await memory.drop();
    memory.requests.splice(0);

    const second = await memory.drop();

    expect([
      second.outcome === "already-dropped" ? [second.outcome, second.receipt.indexes] : second,
      memory.requests,
      (await memory.receipt())?.data.version,
    ]).toEqual([["already-dropped", [OWN_INDEX]], [], 0]);
  });

  test("an index that is already gone still records the drop", async () => {
    const memory = installation({ missing: true });
    await memory.hold("operator", "eval-closeout", "manual");

    const result = await memory.drop();

    expect([result.outcome, memory.requests, (await memory.receipt())?.data.indexes]).toEqual([
      "dropped",
      [{ method: "DELETE", path: `/${OWN_INDEX}` }],
      [OWN_INDEX],
    ]);
  });

  test("never deletes an index whose name is not exactly the organization's own", async () => {
    const results = [];
    for (const index of ["memory-*", "memory-a,memory-b"]) {
      const memory = installation({}, index);
      await memory.hold("operator", "eval-closeout", "manual");
      results.push([await memory.drop(), memory.requests, await memory.receipt()]);
    }

    expect(results).toEqual([
      [
        {
          kept: [
            { index: "memory-*", reason: "not-organization-index" },
            { index: OTHER_INDEX, reason: "owned-by-another-organization" },
          ],
          outcome: "nothing-to-drop",
        },
        [],
        undefined,
      ],
      [
        {
          kept: [
            { index: "memory-a,memory-b", reason: "not-organization-index" },
            { index: OTHER_INDEX, reason: "owned-by-another-organization" },
          ],
          outcome: "nothing-to-drop",
        },
        [],
        undefined,
      ],
    ]);
  });
});
