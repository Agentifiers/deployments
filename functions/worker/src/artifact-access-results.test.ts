import { describe, expect, test } from "bun:test";
import type { PlatformRecord, Ulid } from "@deployments-ai/db";
import { preparedArtifactAccessResult } from "./artifact-access-results.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const artifact = {
  data: {
    createdAt: "2026-07-29T00:00:00.000Z",
    id: id("10"),
    name: "report",
    runId: id("07"),
    status: "available",
    storage: {
      byteSize: 6,
      contentType: "text/plain",
      fileName: "report.txt",
    },
    type: "report",
    visibility: "organization",
  },
  itemType: "artifact",
} as Extract<PlatformRecord, { readonly itemType: "artifact" }>;

describe("artifact access results", () => {
  test.each(["inspect", "provider-handoff"] as const)(
    "keeps %s metadata durable while access URLs remain transient",
    (purpose) => {
      const first = preparedArtifactAccessResult(
        artifact,
        "2026-07-29T01:15:00.000Z",
        "https://artifacts.example/first",
        purpose,
      );
      const retried = preparedArtifactAccessResult(
        artifact,
        "2026-07-29T02:15:00.000Z",
        "https://artifacts.example/retried",
        purpose,
      );

      expect(retried.artifacts).toEqual(first.artifacts);
      expect(String(first.artifacts?.[0]?.content)).not.toContain("artifacts.example");
      expect(retried.transientArtifacts).not.toEqual(first.transientArtifacts);
      expect(String(retried.transientArtifacts[0]?.content)).toContain("/retried");
      expect(retried.transientArtifacts[0]?.metadata).toMatchObject({
        artifactId: artifact.data.id,
        kind: "artifact-access",
        purpose,
      });
    },
  );
});
