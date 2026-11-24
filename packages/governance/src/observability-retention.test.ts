import type { PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  BLOB_REFERENCE_FIELDS,
  deleteTenantErasureObjectPrefixes,
} from "./governance-service-support.ts";
import { isActive, retentionClass } from "./governance-record-classification.ts";
import type { GovernanceServiceOptions } from "./types.ts";

const record = (
  itemType:
    | "message-publication"
    | "model-invocation"
    | "slack-agent-stream"
    | "teams-agent-stream"
    | "trace",
  status?: "failed" | "finalized" | "open" | "paused" | "stopped" | "streaming",
  fallbackAllowed?: boolean,
) => ({ data: { ...(status ? { status } : {}), fallbackAllowed }, itemType }) as PlatformRecord;

describe("observability governance", () => {
  test("applies run retention to traces and model invocation attempts", () => {
    expect(retentionClass(record("trace", "finalized"))).toBe("runs");
    expect(retentionClass(record("model-invocation"))).toBe("runs");
    expect(retentionClass(record("slack-agent-stream"))).toBe("runs");
    expect(retentionClass(record("teams-agent-stream"))).toBe("runs");
    expect(retentionClass(record("message-publication"))).toBe("runs");
    expect(
      isActive(
        record("message-publication") as Extract<
          PlatformRecord,
          { readonly itemType: "message-publication" }
        >,
      ),
    ).toBe(false);
    expect(
      isActive({
        ...record("message-publication"),
        data: { status: "reserved" },
      } as Extract<PlatformRecord, { readonly itemType: "message-publication" }>),
    ).toBe(true);
    expect(
      isActive({
        ...record("message-publication"),
        data: { status: "committed" },
      } as Extract<PlatformRecord, { readonly itemType: "message-publication" }>),
    ).toBe(true);
  });

  test("preserves open traces and deletes invocation body references with their records", () => {
    expect(isActive(record("trace", "open"))).toBe(true);
    expect(isActive(record("trace", "finalized"))).toBe(false);
    expect(BLOB_REFERENCE_FIELDS["model-invocation"]).toEqual([
      "requestBodyRef",
      "responseBodyRef",
    ]);
  });

  test("preserves unresolved Slack stream fences", () => {
    expect(isActive(record("slack-agent-stream", "streaming"))).toBe(true);
    expect(isActive(record("slack-agent-stream", "paused"))).toBe(true);
    expect(isActive(record("slack-agent-stream", "failed", false))).toBe(true);
    expect(isActive(record("slack-agent-stream", "failed", true))).toBe(false);
    expect(isActive(record("slack-agent-stream", "stopped"))).toBe(false);
  });

  test("preserves unresolved Teams stream fences", () => {
    expect(isActive(record("teams-agent-stream", "streaming"))).toBe(true);
    expect(isActive(record("teams-agent-stream", "paused"))).toBe(true);
    expect(isActive(record("teams-agent-stream", "failed", false))).toBe(true);
    expect(isActive(record("teams-agent-stream", "failed", true))).toBe(false);
    expect(isActive(record("teams-agent-stream", "stopped"))).toBe(false);
  });

  test("erases every version under configured tenant quarantine prefixes", async () => {
    const deleted: unknown[] = [];
    const options = {
      allowedObjectBuckets: ["observability-quarantine"],
      objectStore: {
        deleteAllVersionsUnderPrefix: async (reference: unknown) => void deleted.push(reference),
      },
      tenantErasureObjectPrefixes: [
        { bucket: "observability-quarantine", keyPrefixRoot: "organizations" },
      ],
    } as unknown as GovernanceServiceOptions;

    await deleteTenantErasureObjectPrefixes(options, "01ARZ3NDEKTSV4RRFFQ69G5FAV");

    expect(deleted).toEqual([
      {
        bucket: "observability-quarantine",
        keyPrefix: "organizations/01ARZ3NDEKTSV4RRFFQ69G5FAV/",
      },
    ]);
  });
});
