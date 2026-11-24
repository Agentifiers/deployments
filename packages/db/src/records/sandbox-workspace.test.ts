import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES, SandboxWorkspaceRecord } from "./sandboxes.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);
const organizationId = id("1");
const threadId = id("2");
const timestamp = "2026-09-29T12:00:00.000Z";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    bucket: "artifacts",
    byteSize: 2048,
    capturedAt: timestamp,
    key: `organizations/${organizationId}/sandbox-workspaces/snapshot.tar.gz`,
    leaseId: id("9"),
    sha256: "a".repeat(64),
    versionId: "s3-version-1",
    ...overrides,
  };
}

function decode(data: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(SandboxWorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        environmentId: id("4"),
        executionTargetId: id("3"),
        executionTargetKind: "agent-deployment",
        id: id("5"),
        organizationId,
        projectId: id("6"),
        threadId,
        updatedAt: timestamp,
        version: 0,
        ...data,
      },
      itemType: "sandbox-workspace" as const,
    }),
  );
}

describe("sandbox workspace record", () => {
  test("accepts a committed snapshot at the transfer-size boundary", () => {
    const record = decode({
      leaseId: id("9"),
      leaseRunId: id("8"),
      restoredLeaseId: id("7"),
      snapshot: snapshot({ byteSize: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES }),
    });

    expect(record.data.snapshot?.byteSize).toBe(MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES);
  });

  test("rejects snapshot digests that are not lowercase hex SHA-256", () => {
    for (const sha256 of ["A".repeat(64), "a".repeat(63), `sha256:${"a".repeat(64)}`]) {
      expect(() => decode({ snapshot: snapshot({ sha256 }) })).toThrow("lowercase hex SHA-256");
    }
  });

  test("rejects empty, fractional, and oversized snapshots", () => {
    for (const [byteSize, reason] of [
      [0, "must not be empty"],
      [1.5, "must be integers"],
      [MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES + 1, "exceed the supported maximum size"],
    ] as const) {
      expect(() => decode({ snapshot: snapshot({ byteSize }) })).toThrow(reason);
    }
  });

  test("rejects snapshots stored outside the organization prefix", () => {
    expect(() =>
      decode({
        snapshot: snapshot({
          key: `organizations/${id("A")}/sandbox-workspaces/snapshot.tar.gz`,
        }),
      }),
    ).toThrow("organization prefix");
    expect(() =>
      decode({
        snapshot: snapshot({ key: `sandbox-workspaces/${organizationId}/snapshot.tar.gz` }),
      }),
    ).toThrow("organization prefix");
  });

  test("bounds snapshot failure reasons and codes", () => {
    const failure = (reason: string, code = "snapshot-failed") => ({
      lastSnapshotFailure: { at: timestamp, code, leaseId: id("9"), reason },
    });
    expect(decode(failure("x".repeat(1024))).data.lastSnapshotFailure?.reason).toHaveLength(1024);
    for (const code of ["archive-too-large", "snapshot-failed", "snapshot-incomplete"] as const) {
      expect(decode(failure("x", code)).data.lastSnapshotFailure?.code).toBe(code);
    }
    expect(() => decode(failure(""))).toThrow("must not be empty");
    expect(() => decode(failure("x".repeat(1025)))).toThrow("exceed the supported length");
    expect(() => decode(failure("x", "unknown"))).toThrow();
  });
});
