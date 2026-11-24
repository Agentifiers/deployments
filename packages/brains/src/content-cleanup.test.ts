import { describe, expect, test } from "bun:test";
import { advanceBrainContentCleanup } from "./content-cleanup.ts";

describe("Brain content cleanup", () => {
  test("deletes every exact version and requires two empty scans across quiescence", async () => {
    const versions = new Set(["version-1", "delete-marker-1"]);
    const objectStore = {
      deleteVersion: async ({ versionId }: { readonly versionId: string }) => {
        versions.delete(versionId);
      },
      listExactKeyVersions: async () => ({
        deleteMarkers: [...versions].filter((value) => value.startsWith("delete")),
        versionIds: [...versions].filter((value) => value.startsWith("version")),
      }),
    };
    const first = await advanceBrainContentCleanup({
      now: "2026-07-30T12:00:00.000Z",
      objectStore,
      state: {
        bucket: "content",
        objectKey: "organizations/org/brains/brain/upload",
        status: "pending",
        verificationCount: 0,
        version: 0,
      },
    });
    expect(first).toMatchObject({
      quiescenceStartedAt: "2026-07-30T12:00:00.000Z",
      status: "deleting",
      verificationCount: 1,
    });

    const tooSoon = await advanceBrainContentCleanup({
      now: "2026-07-30T12:00:30.000Z",
      objectStore,
      state: first,
    });
    expect(tooSoon).toEqual(first);

    const verified = await advanceBrainContentCleanup({
      now: "2026-07-30T12:01:01.000Z",
      objectStore,
      state: first,
    });
    expect(verified).toMatchObject({ status: "verified", verificationCount: 2 });
  });

  test("resets verification when an exact object version reappears", async () => {
    let scans = 0;
    const state = await advanceBrainContentCleanup({
      now: "2026-07-30T12:02:00.000Z",
      objectStore: {
        deleteVersion: async () => undefined,
        listExactKeyVersions: async () =>
          ++scans === 1
            ? { deleteMarkers: [], versionIds: [] }
            : { deleteMarkers: [], versionIds: ["late-version"] },
      },
      state: {
        bucket: "content",
        objectKey: "key",
        quiescenceStartedAt: "2026-07-30T12:00:00.000Z",
        status: "deleting",
        verificationCount: 1,
        version: 1,
      },
    });
    expect(state).toMatchObject({ status: "deleting", verificationCount: 0 });
  });
});
