import { describe, expect, test } from "bun:test";
import {
  canResolveApproval,
  isRunInFlight,
  RUN_ACTIONS,
  runErrorAdvice,
  runErrorText,
} from "./run-state.ts";

describe("RUN_ACTIONS", () => {
  test("cancel until terminal, retry only after failure, replay any terminal run", () => {
    expect(RUN_ACTIONS).toEqual({
      canceled: ["replay"],
      completed: ["replay"],
      failed: ["retry", "replay"],
      queued: ["cancel"],
      running: ["cancel"],
      "waiting-for-approval": ["cancel"],
      "waiting-for-tool": ["cancel"],
    });
  });
});

describe("isRunInFlight", () => {
  test("queued, running, and waiting runs are in flight", () => {
    expect(isRunInFlight("queued")).toBe(true);
    expect(isRunInFlight("running")).toBe(true);
    expect(isRunInFlight("waiting-for-approval")).toBe(true);
    expect(isRunInFlight("waiting-for-tool")).toBe(true);
  });

  test("terminal runs are not", () => {
    expect(isRunInFlight("canceled")).toBe(false);
    expect(isRunInFlight("completed")).toBe(false);
    expect(isRunInFlight("failed")).toBe(false);
  });
});

describe("runErrorText", () => {
  test("shows the recorded message, prefixed by its code when there is one", () => {
    expect(runErrorText({ message: "Agent run failed." })).toBe("Agent run failed.");
    expect(runErrorText({ code: "budget_exhausted", message: "Monthly budget spent." })).toBe(
      "budget_exhausted: Monthly budget spent.",
    );
  });

  test("falls back to the JSON of an error without a message", () => {
    expect(runErrorText({ reason: "lease lost", retryable: false })).toBe(
      '{"reason":"lease lost","retryable":false}',
    );
  });

  test("no error, no text", () => {
    expect(runErrorText(undefined)).toBeUndefined();
  });
});

describe("canResolveApproval", () => {
  test("a pending customer or preview approval of a waiting run", () => {
    expect(
      canResolveApproval(
        { executionPurpose: "customer", status: "pending" },
        "waiting-for-approval",
      ),
    ).toBe(true);
    expect(
      canResolveApproval(
        { executionPurpose: "preview", status: "pending" },
        "waiting-for-approval",
      ),
    ).toBe(true);
  });

  test("never an evaluation approval, a resolved one, or one whose run moved on", () => {
    expect(
      canResolveApproval(
        { executionPurpose: "evaluation", status: "pending" },
        "waiting-for-approval",
      ),
    ).toBe(false);
    expect(
      canResolveApproval(
        { executionPurpose: "customer", status: "approved" },
        "waiting-for-approval",
      ),
    ).toBe(false);
    expect(
      canResolveApproval({ executionPurpose: "customer", status: "pending" }, "canceled"),
    ).toBe(false);
  });
});

describe("runErrorAdvice", () => {
  test("explains a workspace-memory agent run without a workspace and points at its configuration", () => {
    expect(
      runErrorAdvice({ message: "Runtime workspace memory mode requires a workspaceId." }),
    ).toEqual({
      explanation: expect.stringContaining("every run needs a workspace"),
      fix: "agent-configuration",
    });
  });

  test("gives no advice for an error it does not know", () => {
    expect(runErrorAdvice({ message: "Agent run failed." })).toBeUndefined();
    expect(runErrorAdvice(undefined)).toBeUndefined();
  });
});
