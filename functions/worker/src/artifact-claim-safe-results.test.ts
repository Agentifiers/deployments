import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  MAX_HANDOFF_PROVIDER_INPUT_BYTES,
  providerInput,
  publicArtifact,
  sharedArtifactVisibility,
} from "./artifact-lifecycle-runtime-tools.ts";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;

describe("claimed artifact mutation results", () => {
  test("only promotes private visibility when sharing", () => {
    expect(sharedArtifactVisibility("private")).toBe("organization");
    expect(sharedArtifactVisibility("organization")).toBe("organization");
    expect(sharedArtifactVisibility("public")).toBe("public");
  });

  test("rejects provider plans that cannot fit the replay envelope before persistence", () => {
    expect(() =>
      providerInput({ providerInput: { text: "x".repeat(MAX_HANDOFF_PROVIDER_INPUT_BYTES) } }),
    ).toThrow(`providerInput must not exceed ${MAX_HANDOFF_PROVIDER_INPUT_BYTES} encoded bytes`);
  });

  test("omits potentially item-sized metadata from mutation result projections", () => {
    const record = {
      data: {
        createdAt: "2026-07-29T00:00:00.000Z",
        id: "01J00000000000000000000010",
        metadata: { payload: "x".repeat(350_000) },
        name: "report",
        status: "available",
        storage: {
          byteSize: 6,
          contentType: "text/plain",
          fileName: "report.txt",
        },
        type: "report",
        updatedAt: "2026-07-29T00:00:00.000Z",
        version: 1,
        visibility: "organization",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as Artifact;

    const projection = publicArtifact(record, false);

    expect(projection).not.toHaveProperty("metadata");
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThan(4_096);
  });
});
