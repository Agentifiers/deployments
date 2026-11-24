import { TenantErasureResponse } from "@deployments-ai/api-contract/governance";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { erasureState } from "./erasure-state.ts";

const OPERATION = "01M4D00000000000000000000E";
const erasure = (fields: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(TenantErasureResponse)({
    createdAt: "2026-10-07T12:00:00.000Z",
    id: OPERATION,
    kind: "tenant-erasure",
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
    updatedAt: "2026-10-07T12:01:00.000Z",
    version: 1,
    ...fields,
  });

describe("erasureState", () => {
  test("no erasure on record", () => {
    expect(erasureState(undefined)).toEqual({ kind: "not_requested" });
  });

  test("pending and running erasures are in progress", () => {
    expect(erasureState(erasure({ status: "pending" }))).toEqual({
      kind: "in_progress",
      operationId: OPERATION,
    });
    expect(
      erasureState(erasure({ startedAt: "2026-10-07T12:00:05.000Z", status: "running" })),
    ).toEqual({
      kind: "in_progress",
      operationId: OPERATION,
      startedAt: "2026-10-07T12:00:05.000Z",
    });
  });

  test("a known runner failure is a blocker the owner can resume past", () => {
    expect(
      erasureState(
        erasure({
          error: { code: "tenant_has_active_runs", message: "Runs are active." },
          status: "failed",
        }),
      ),
    ).toEqual({
      blocker: { kind: "tenant_has_active_runs" },
      kind: "blocked",
      operationId: OPERATION,
    });
  });

  test("an unknown failure keeps the platform's reason", () => {
    expect(
      erasureState(
        erasure({
          error: { code: "kms_unavailable", message: "KMS timed out." },
          status: "failed",
        }),
      ),
    ).toEqual({
      blocker: { error: { code: "kms_unavailable", message: "KMS timed out." }, kind: "other" },
      kind: "blocked",
      operationId: OPERATION,
    });
  });

  test("a completed erasure carries its receipt", () => {
    const receipt = {
      auditRootHash: "d".repeat(64),
      memorySearch: { backupsExpireBy: "2026-10-21T13:10:00.000Z" },
      observability: {
        backupsExpireBy: "2026-11-06T12:00:00.000Z",
        clickhouseRowsDeleted: 120,
        icebergRowsDeleted: 30,
        physicalRemovalBy: "2026-10-14T12:00:00.000Z",
      },
      recordsDeleted: 5120,
    };
    expect(
      erasureState(
        erasure({ completedAt: "2026-10-07T12:30:00.000Z", status: "completed", summary: receipt }),
      ),
    ).toEqual({
      completedAt: "2026-10-07T12:30:00.000Z",
      kind: "erased",
      operationId: OPERATION,
      receipt,
    });
  });
});
