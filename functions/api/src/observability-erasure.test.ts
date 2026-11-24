import { describe, expect, test } from "bun:test";
import type { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  makeObservabilityErasureInvoker,
  OBSERVABILITY_ERASURE_FUNCTION_ENV,
} from "./observability-erasure.ts";

const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const request = {
  drainAnchorAt: "2026-07-25T00:00:00.000Z",
  operationId: OPERATION_ID,
  organizationId: ORGANIZATION_ID,
  progress: { phase: "iceberg" },
};
const receipt = {
  clickhouse: { absenceVerifiedAt: "2026-07-25T00:20:00.000Z", rowsDeleted: 7 },
  clickhouseBackupsExpireBy: "2026-08-24T00:20:00.000Z",
  iceberg: {
    absenceVerifiedAt: "2026-07-25T00:25:00.000Z",
    physicalRemovalBy: "2026-07-28T00:25:00.000Z",
    rowsDeleted: 5,
    tables: [
      { rowsDeleted: 3, table: "spans" },
      { rowsDeleted: 2, table: "traces" },
    ],
  },
  operationId: OPERATION_ID,
};

function invoker(response: { FunctionError?: string; payload?: unknown }) {
  const commands: InvokeCommand[] = [];
  const invoke = makeObservabilityErasureInvoker(
    { [OBSERVABILITY_ERASURE_FUNCTION_ENV]: " observability-erasure " },
    {
      send: async (command) => {
        commands.push(command);
        return {
          ...(response.FunctionError ? { FunctionError: response.FunctionError } : {}),
          ...(response.payload === undefined
            ? {}
            : { Payload: Buffer.from(JSON.stringify(response.payload)) }),
        };
      },
    },
  );
  if (!invoke) throw new Error("expected a configured invoker");
  return { commands, invoke };
}

describe("observability erasure invoker", () => {
  test("is not configured when the erasure function is not deployed", () => {
    expect(makeObservabilityErasureInvoker({})).toBeUndefined();
    expect(
      makeObservabilityErasureInvoker({ [OBSERVABILITY_ERASURE_FUNCTION_ENV]: " " }),
    ).toBeUndefined();
  });

  test("invokes synchronously with the drain anchor and persisted progress", async () => {
    const { commands, invoke } = invoker({
      payload: { progress: { phase: "drain" }, reason: "pipeline_draining", status: "pending" },
    });

    expect(invoke(request)).resolves.toEqual({
      progress: { phase: "drain" },
      reason: "pipeline_draining",
      status: "pending",
    });
    expect(commands[0]?.input.FunctionName).toBe("observability-erasure");
    expect(commands[0]?.input.InvocationType).toBe("RequestResponse");
    expect(JSON.parse(new TextDecoder().decode(commands[0]?.input.Payload as Uint8Array))).toEqual(
      request,
    );
  });

  test("decodes a complete receipt for the requested operation", async () => {
    expect(invoker({ payload: { receipt, status: "complete" } }).invoke(request)).resolves.toEqual({
      receipt,
      status: "complete",
    });
  });

  test.each([
    ["an unknown pending reason", { progress: {}, reason: "waiting", status: "pending" }],
    ["pending without progress", { reason: "pipeline_draining", status: "pending" }],
    ["unexpected fields", { extra: true, receipt, status: "complete" }],
    [
      "another operation's receipt",
      { receipt: { ...receipt, operationId: ORGANIZATION_ID }, status: "complete" },
    ],
    [
      "negative row counts",
      {
        receipt: { ...receipt, clickhouse: { ...receipt.clickhouse, rowsDeleted: -1 } },
        status: "complete",
      },
    ],
    [
      "inconsistent Iceberg totals",
      {
        receipt: { ...receipt, iceberg: { ...receipt.iceberg, rowsDeleted: 6 } },
        status: "complete",
      },
    ],
    [
      "non-canonical boundaries",
      { receipt: { ...receipt, clickhouseBackupsExpireBy: "2026-08-24" }, status: "complete" },
    ],
    ["an empty response", undefined],
  ])("rejects %s", async (_name, payload) => {
    expect(invoker({ payload }).invoke(request)).rejects.toThrow(
      "Observability erasure failed: the purge returned an invalid response.",
    );
  });

  test("surfaces purge function errors for the governance retry path", async () => {
    expect(
      invoker({
        FunctionError: "Unhandled",
        payload: { errorMessage: "Erasure fence does not match the operation." },
      }).invoke(request),
    ).rejects.toThrow("Observability erasure failed: Erasure fence does not match the operation.");
  });
});
