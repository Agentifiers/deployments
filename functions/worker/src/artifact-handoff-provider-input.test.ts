import { describe, expect, test } from "bun:test";
import {
  assertArtifactHandoffMetadata,
  assertProviderHandoffIntentNotExpired,
} from "./artifact-handoff-provider-input.ts";

describe("artifact handoff provider input", () => {
  const artifact = {
    name: "report",
    storage: { contentType: "text/plain", fileName: "report.txt" },
  };

  test("requires audit metadata to match canonical artifact storage", () => {
    expect(() =>
      assertArtifactHandoffMetadata(
        { contentType: "text/plain", fileName: "report.txt" },
        artifact,
      ),
    ).not.toThrow();
    expect(() =>
      assertArtifactHandoffMetadata(
        { contentType: "text/html", fileName: "innocent.txt" },
        artifact,
      ),
    ).toThrow("does not match the canonical artifact");
  });

  test("rejects an intent that expires during access preparation", () => {
    expect(() =>
      assertProviderHandoffIntentNotExpired(
        { expiresAt: "2026-07-30T01:00:00.000Z" },
        "2026-07-30T01:00:00.000Z",
      ),
    ).toThrow("has expired");
  });
});
