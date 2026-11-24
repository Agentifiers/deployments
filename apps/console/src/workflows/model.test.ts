import { describe, expect, test } from "bun:test";
import { PublicId, WorkflowExecutionStatus } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { attempt, DOCUMENT } from "./model.fixture.ts";
import {
  approvalOutcome,
  approvalPanel,
  approvalQueueRows,
  approvalPrompt,
  CANCELABLE,
  definitionEmptyTitle,
  describeApprovalOutcome,
  draftEditOf,
  EXECUTION_PHASE,
  EXECUTION_STATUSES,
  executionEmptyTitle,
  parseDefinitionFilters,
  parseExecutionFilters,
  parseJsonObject,
  pendingStepOf,
} from "./model.ts";

describe("execution statuses", () => {
  test("list every status the contract declares exactly once", () => {
    expect([...EXECUTION_STATUSES].toSorted()).toEqual(
      [...WorkflowExecutionStatus.literals].toSorted(),
    );
  });

  test("only finished executions stop changing", () => {
    expect(EXECUTION_STATUSES.filter((status) => EXECUTION_PHASE[status] === "terminal")).toEqual([
      "completed",
      "failed",
      "canceled",
    ]);
  });
});

describe("filters from the URL", () => {
  test("keep a known status and drop the default or an unknown one", () => {
    expect([
      parseDefinitionFilters({ status: "archived" }),
      parseDefinitionFilters({ status: "active" }),
      parseDefinitionFilters({ status: "deleted" }),
      parseExecutionFilters({ status: "waiting-for-approval" }),
      parseExecutionFilters({ status: "waiting" }),
    ]).toEqual([{ status: "archived" }, {}, {}, { status: "waiting-for-approval" }, {}]);
  });
});

describe("empty list titles", () => {
  test("name the filter once nothing is left to load", () => {
    expect([
      definitionEmptyTitle({}, 0, false),
      definitionEmptyTitle({ status: "archived" }, 0, false),
      definitionEmptyTitle({ status: "all" }, 0, false),
      executionEmptyTitle({}, 0, false),
      executionEmptyTitle({ status: "waiting-for-approval" }, 0, false),
    ]).toEqual([
      "No active workflows",
      "No archived workflows",
      "No workflows yet",
      "No executions yet",
      "No waiting-for-approval executions",
    ]);
  });

  test("stay hidden while rows show or a cursor remains", () => {
    expect([
      definitionEmptyTitle({ status: "archived" }, 0, true),
      definitionEmptyTitle({}, 3, false),
      executionEmptyTitle({ status: "failed" }, 0, true),
      executionEmptyTitle({}, 1, true),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("pendingStepOf", () => {
  const execution = {
    currentStepId: "review",
    id: Schema.decodeUnknownSync(PublicId)("01K0000000000000000000000E"),
    status: "waiting-for-approval" as const,
  };

  test("finds the waiting approval attempt of the current step", () => {
    expect(
      pendingStepOf(execution, [
        attempt({ approvalId: "01K0000000000000000000000P", status: "canceled" }),
        attempt({
          approvalId: "01K0000000000000000000000Q",
          id: "01K0000000000000000000000Q",
          startedAt: "2026-10-09T05:01:00.000Z",
          status: "waiting",
        }),
      ]),
    ).toEqual({
      approvalId: "01K0000000000000000000000Q",
      executionId: "01K0000000000000000000000E",
      stepId: "review",
      waitingSince: "2026-10-09T05:01:00.000Z",
    });
  });

  test("finds nothing once the execution moved on or the attempt has no approval yet", () => {
    const waiting = attempt({ approvalId: "01K0000000000000000000000Q", status: "waiting" });
    expect([
      pendingStepOf({ ...execution, status: "completed" }, [waiting]),
      pendingStepOf(execution, [attempt({ status: "waiting" })]),
      pendingStepOf(execution, [waiting])?.approvalId,
    ]).toEqual([undefined, undefined, "01K0000000000000000000000Q"]);
  });
});

describe("approvalPanel", () => {
  const step = (approvalId: string) => ({
    approvalId,
    executionId: "01K0000000000000000000000E",
    stepId: "review",
    waitingSince: "2026-10-09T00:00:00.000Z",
  });

  test("keeps the open dialog's approval after the poll moves the execution on", () => {
    expect([
      approvalPanel({ held: step("A"), settledApprovalId: undefined, waiting: undefined }),
      approvalPanel({ held: step("A"), settledApprovalId: "A", waiting: undefined }),
      approvalPanel({ held: step("A"), settledApprovalId: "A", waiting: step("A") }),
    ]).toEqual([
      { settling: false, target: step("A") },
      { settling: false, target: step("A") },
      { settling: true, target: step("A") },
    ]);
  });

  test("drops a decided approval and holds back cancel until the poll catches up", () => {
    expect([
      approvalPanel({ held: undefined, settledApprovalId: undefined, waiting: step("A") }),
      approvalPanel({ held: undefined, settledApprovalId: "A", waiting: step("A") }),
      approvalPanel({ held: undefined, settledApprovalId: "A", waiting: step("B") }),
      approvalPanel({ held: undefined, settledApprovalId: "A", waiting: undefined }),
    ]).toEqual([
      { settling: false, target: step("A") },
      { settling: true, target: undefined },
      { settling: false, target: step("B") },
      { settling: false, target: undefined },
    ]);
  });
});

describe("approvalQueueRows", () => {
  const row = (approvalId: string, prompt: string) => ({
    approvalId,
    executionId: `01K000000000000000000000E${approvalId}`,
    prompt,
    releaseId: "01K0000000000000000000000R",
    releaseNumber: 1,
    stepId: "review",
    waitingSince: "2026-10-09T00:00:00.000Z",
    workflowName: "gate",
  });
  const rowsOf = (...args: Parameters<typeof approvalQueueRows>) =>
    approvalQueueRows(...args).map(({ approvalId, prompt }) => `${approvalId}:${prompt}`);

  test("keeps the open dialog's approval after a refresh stops listing it", () => {
    expect([
      rowsOf([row("A", "opened"), row("B", "opened")], row("A", "opened")),
      rowsOf([row("B", "refreshed")], row("A", "opened")),
      rowsOf([], row("A", "opened")),
    ]).toEqual([["A:opened", "B:opened"], ["B:refreshed", "A:opened"], ["A:opened"]]);
  });

  test("shows the refreshed row while it is listed and drops it once the dialog closes", () => {
    expect([
      rowsOf([row("A", "refreshed")], row("A", "opened")),
      rowsOf([row("B", "refreshed")], undefined),
      rowsOf([], undefined),
    ]).toEqual([["A:refreshed"], ["B:refreshed"], []]);
  });
});

describe("approvalPrompt", () => {
  test("reads the prompt of an approval step and nothing for other steps", () => {
    expect([approvalPrompt(DOCUMENT, "review"), approvalPrompt(DOCUMENT, "approved")]).toEqual([
      "QA: approve this execution?",
      undefined,
    ]);
  });
});

describe("approvalOutcome", () => {
  test("separates an applied decision from an expired or already closed approval", () => {
    expect([
      approvalOutcome("approved", "approved"),
      approvalOutcome("rejected", "rejected"),
      approvalOutcome("approved", "expired"),
      approvalOutcome("approved", "canceled"),
      approvalOutcome("rejected", "approved"),
    ]).toEqual([
      { kind: "applied", status: "approved" },
      { kind: "applied", status: "rejected" },
      { kind: "expired" },
      { kind: "already-closed", status: "canceled" },
      { kind: "already-closed", status: "approved" },
    ]);
  });

  test("tells the user whether their decision applied", () => {
    expect([
      describeApprovalOutcome({ kind: "applied", status: "approved" }),
      describeApprovalOutcome({ kind: "applied", status: "rejected" }),
      describeApprovalOutcome({ kind: "expired" }),
      describeApprovalOutcome({ kind: "already-closed", status: "canceled" }),
    ]).toEqual([
      "Approved.",
      "Rejected.",
      "Your decision was not applied. The approval's deadline had passed, so it closed as expired.",
      "Nothing changed. The approval was already canceled.",
    ]);
  });
});

describe("draftEditOf", () => {
  test("pins the version the editor text was loaded from", () => {
    expect(draftEditOf({ draft: { entryStepId: "review", name: "Gate" }, version: 3 })).toEqual({
      expectedVersion: 3,
      text: '{\n  "entryStepId": "review",\n  "name": "Gate"\n}',
    });
  });
});

describe("cancel availability", () => {
  test("offers cancel only while an execution runs or waits", () => {
    expect(EXECUTION_STATUSES.filter((status) => CANCELABLE[EXECUTION_PHASE[status]])).toEqual([
      "waiting-for-approval",
      "waiting-for-agent",
      "waiting-for-tool",
      "waiting-for-delivery",
      "queued",
      "running",
    ]);
  });
});

describe("parseJsonObject", () => {
  test("accepts an object and explains anything else", () => {
    expect([
      parseJsonObject("  "),
      parseJsonObject('{"a": 1}'),
      parseJsonObject("[1]"),
      parseJsonObject("{").kind,
    ]).toEqual([
      { kind: "empty" },
      { kind: "object", value: { a: 1 } },
      { kind: "invalid", message: "Enter a JSON object." },
      "invalid",
    ]);
  });
});
