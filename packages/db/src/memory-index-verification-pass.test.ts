import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "./dynamo-database.ts";
import type { Ulid } from "./ids.ts";
import {
  getMemoryIndexVerificationPass,
  recordMemoryIndexVerificationPass,
  type MemoryIndexVerificationPass,
  type MemoryIndexVerificationProgress,
} from "./memory-index-verification-pass.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006" as Ulid;
const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G6007" as Ulid,
  organizationId,
  projectId: "01ARZ3NDEKTSV4RRFFQ69G6008" as Ulid,
};
const workspaceId = "01ARZ3NDEKTSV4RRFFQ69G6009" as Ulid;
const targetId = "01M403FMNP7S2YVJ5Y67R3J87H" as Ulid;
const position = {
  gsi2pk: `MEMORY-SEARCH-TARGET#${targetId}`,
  gsi2sk: `MEMORY-INDEX-STATE#ready#2026-10-20T10:00:00.000Z#${targetId}`,
  pk: `ORG#${organizationId}#MEMORY#01M403FR0Z4VNNQWM841K3XHP7`,
  sk: `MEMORY-INDEX-STATE#${targetId}`,
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
  return { database: makeDynamoDatabase(dynamo.client), dynamo };
}

function walk(
  previous: MemoryIndexVerificationPass | undefined,
  progress: MemoryIndexVerificationProgress,
  now: string,
) {
  return { now, previous, progress, scope, targetId };
}

describe("memory index verification pass", () => {
  test("keeps one pass per scope and target and advances it by version", async () => {
    const { database, dynamo } = store();

    expect(
      await recordMemoryIndexVerificationPass(
        database,
        walk(
          undefined,
          { cutoff: "2026-10-21T10:00:00.000Z", indexStatus: "deleted" },
          "2026-10-22T10:00:00.000Z",
        ),
      ),
    ).toBe(true);
    const first = await getMemoryIndexVerificationPass(database, scope, targetId);
    expect(
      await recordMemoryIndexVerificationPass(
        database,
        walk(
          first,
          { cutoff: "2026-10-21T10:00:00.000Z", indexStatus: "ready", resumeAfter: position },
          "2026-10-22T10:05:00.000Z",
        ),
      ),
    ).toBe(true);

    expect(
      dynamo.get("control", {
        pk: `ORG#${organizationId}#ENV#${scope.environmentId}`,
        sk: `MEMORY-INDEX-VERIFICATION-PASS#${targetId}#ENVIRONMENT`,
      }),
    ).toEqual({
      data: {
        ...scope,
        createdAt: "2026-10-22T10:00:00.000Z",
        cutoff: "2026-10-21T10:00:00.000Z",
        indexStatus: "ready",
        resumeAfter: position,
        targetId,
        updatedAt: "2026-10-22T10:05:00.000Z",
        version: 1,
      },
      gsi1pk: `ORG#${organizationId}`,
      gsi1sk: `MEMORY-INDEX-VERIFICATION-PASS#all#2026-10-22T10%3A05%3A00.000Z#${targetId}#ENVIRONMENT`,
      gsi2pk: `ENV#${scope.environmentId}`,
      gsi2sk: `MEMORY-INDEX-VERIFICATION-PASS#all#2026-10-22T10%3A05%3A00.000Z#${targetId}#ENVIRONMENT`,
      itemType: "memory-index-verification-pass",
      pk: `ORG#${organizationId}#ENV#${scope.environmentId}`,
      sk: `MEMORY-INDEX-VERIFICATION-PASS#${targetId}#ENVIRONMENT`,
    });
    expect(dynamo.items("control")).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ recordItemType: "memory-index-verification-pass" }),
        itemType: "governance-tenant-record",
      }),
    );
    expect(
      await getMemoryIndexVerificationPass(database, { ...scope, workspaceId }, targetId),
    ).toBe(undefined);
  });

  test("a concurrent walk that read the same pass yields to the first writer", async () => {
    const { database } = store();
    const workspaceScope = { ...scope, workspaceId };
    await recordMemoryIndexVerificationPass(database, {
      ...walk(
        undefined,
        { cutoff: "2026-10-21T10:00:00.000Z", indexStatus: "deleted" },
        "2026-10-22T10:00:00.000Z",
      ),
      scope: workspaceScope,
    });
    const read = await getMemoryIndexVerificationPass(database, workspaceScope, targetId);

    expect(
      await recordMemoryIndexVerificationPass(database, {
        ...walk(
          undefined,
          { cutoff: "2026-10-21T11:00:00.000Z", indexStatus: "deleted" },
          "2026-10-22T10:01:00.000Z",
        ),
        scope: workspaceScope,
      }),
    ).toBe(false);
    expect(
      await recordMemoryIndexVerificationPass(database, {
        ...walk(
          read,
          { cutoff: "2026-10-21T10:00:00.000Z", indexStatus: "ready", resumeAfter: position },
          "2026-10-22T10:05:00.000Z",
        ),
        scope: workspaceScope,
      }),
    ).toBe(true);
    expect(
      await recordMemoryIndexVerificationPass(database, {
        ...walk(
          read,
          { cutoff: "2026-10-21T10:00:00.000Z", indexStatus: "suppressed" },
          "2026-10-22T10:06:00.000Z",
        ),
        scope: workspaceScope,
      }),
    ).toBe(false);

    const stored = await getMemoryIndexVerificationPass(database, workspaceScope, targetId);
    expect([stored?.sk, stored?.data.indexStatus, stored?.data.version]).toEqual([
      `MEMORY-INDEX-VERIFICATION-PASS#${targetId}#${workspaceId}`,
      "ready",
      1,
    ]);
    expect(await getMemoryIndexVerificationPass(database, scope, targetId)).toBe(undefined);
  });
});
