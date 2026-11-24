import { describe, expect, test } from "bun:test";
import type { Brain } from "@deployments-ai/brains";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  getBrainDuplicatePass,
  recordBrainDuplicatePass,
  type BrainDuplicatePass,
} from "./duplicate-pass-repository.ts";
import { brainPlatformRecord } from "./record-mapping.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const brainId = "01M403FMNP7S2YVJ5Y67R3J87H";
const principalId = "01M403FR0Z4VNNQWM841K3XHP8";
const brain: Brain = {
  createdAt: "2026-10-01T00:00:00.000Z",
  createdByPrincipalId: principalId,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Company knowledge",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-knowledge",
  status: "active",
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedByPrincipalId: principalId,
  version: 1,
};

function store() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-01T00:00:00.000Z",
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  dynamo.put("control", brainPlatformRecord(brain));
  return { database: makeDynamoDatabase(dynamo.client), dynamo };
}

function pass(
  previous: BrainDuplicatePass | undefined,
  contentFingerprint: string,
  duplicateGroups: number,
  now: string,
) {
  return { brain, contentFingerprint, duplicateGroups, now, previous };
}

describe("Brain duplicate pass", () => {
  test("keeps one pass per Brain and advances it by version", async () => {
    const { database, dynamo } = store();

    expect(
      await recordBrainDuplicatePass(
        database,
        pass(undefined, "fingerprint-1", 2, "2026-10-22T10:00:00.000Z"),
      ),
    ).toBe(true);
    const first = await getBrainDuplicatePass(database, organizationId, brainId);
    expect(
      await recordBrainDuplicatePass(
        database,
        pass(first, "fingerprint-2", 3, "2026-10-22T10:05:00.000Z"),
      ),
    ).toBe(true);

    expect(
      dynamo.get("execution", {
        pk: `ORG#${organizationId}#BRAIN#${brainId}`,
        sk: "BRAIN-DUPLICATE-PASS",
      }),
    ).toEqual({
      data: {
        brainId,
        contentFingerprint: "fingerprint-2",
        createdAt: "2026-10-22T10:00:00.000Z",
        duplicateGroups: 3,
        organizationId,
        updatedAt: "2026-10-22T10:05:00.000Z",
        version: 1,
      },
      itemType: "brain-duplicate-pass",
      pk: `ORG#${organizationId}#BRAIN#${brainId}`,
      sk: "BRAIN-DUPLICATE-PASS",
    });
    expect(
      await getBrainDuplicatePass(database, organizationId, "01M403FR0Z4VNNQWM841K3XHP7"),
    ).toBe(undefined);
  });

  test("a concurrent pass that read the same state yields to the first writer", async () => {
    const { database } = store();
    await recordBrainDuplicatePass(
      database,
      pass(undefined, "fingerprint-1", 1, "2026-10-22T10:00:00.000Z"),
    );
    const read = await getBrainDuplicatePass(database, organizationId, brainId);

    expect(
      await recordBrainDuplicatePass(
        database,
        pass(undefined, "fingerprint-x", 9, "2026-10-22T10:01:00.000Z"),
      ),
    ).toBe(false);
    expect(
      await recordBrainDuplicatePass(
        database,
        pass(read, "fingerprint-2", 2, "2026-10-22T10:05:00.000Z"),
      ),
    ).toBe(true);
    expect(
      await recordBrainDuplicatePass(
        database,
        pass(read, "fingerprint-3", 3, "2026-10-22T10:06:00.000Z"),
      ),
    ).toBe(false);

    const stored = await getBrainDuplicatePass(database, organizationId, brainId);
    expect([
      stored?.data.contentFingerprint,
      stored?.data.duplicateGroups,
      stored?.data.version,
    ]).toEqual(["fingerprint-2", 2, 1]);
  });

  test("records nothing once the Brain is no longer the active Brain the pass read", async () => {
    const { database, dynamo } = store();
    dynamo.put("control", brainPlatformRecord({ ...brain, status: "erasing", version: 2 }));

    expect(
      await recordBrainDuplicatePass(
        database,
        pass(undefined, "fingerprint-1", 0, "2026-10-22T10:00:00.000Z"),
      ),
    ).toBe(false);
    expect(await getBrainDuplicatePass(database, organizationId, brainId)).toBe(undefined);
    expect(
      await recordBrainDuplicatePass(database, {
        ...pass(undefined, "fingerprint-1", 0, "2026-10-22T10:00:00.000Z"),
        brain: { ...brain, status: "erasing", version: 2 },
      }),
    ).toBe(false);
    expect(dynamo.items("execution")).toEqual([]);
  });
});
