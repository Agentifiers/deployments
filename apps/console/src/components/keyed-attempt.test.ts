import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { attemptAfterFailure, dialogLock } from "./keyed-attempt.ts";

const problem = (status: number, code: string) =>
  new PlatformApiError("createAgentDeployment", { code, status, title: "T" });

describe("attemptAfterFailure", () => {
  test("a rejection that applied nothing gets a fresh key for the corrected retry", () => {
    const next = attemptAfterFailure(
      { key: "k1", state: "fresh" },
      problem(422, "model_not_in_catalog"),
    );
    expect(next.state).toBe("fresh");
    expect(next.key).not.toBe("k1");
  });

  test("after a lost response, a later rejection keeps the key and rereads live values", () => {
    const lost = attemptAfterFailure({ key: "k1", state: "fresh" }, problem(502, "bad_gateway"));
    expect(lost).toEqual({ key: "k1", state: "resend" });
    const rejected = attemptAfterFailure(lost, problem(409, "tool_bindings_changed"));
    expect(rejected).toEqual({ key: "k1", state: "reread" });
    expect(attemptAfterFailure(rejected, problem(409, "version_conflict"))).toEqual({
      key: "k1",
      state: "reread",
    });
    expect(attemptAfterFailure(rejected, new TypeError("Failed to fetch"))).toEqual({
      key: "k1",
      state: "resend",
    });
  });

  test("a key still running resends its body", () => {
    expect(
      attemptAfterFailure({ key: "k1", state: "fresh" }, problem(409, "idempotency_in_progress")),
    ).toEqual({ key: "k1", state: "resend" });
  });

  test("a request turned away before its body was judged leaves the attempt as it was", () => {
    for (const state of ["fresh", "resend", "reread"] as const) {
      for (const turnedAway of [problem(403, "insufficient_role"), problem(429, "throttled")]) {
        expect(attemptAfterFailure({ key: "k1", state }, turnedAway)).toEqual({ key: "k1", state });
      }
    }
  });

  test("a body refused before or by the operation keeps a kept key and rereads", () => {
    for (const refused of [
      problem(400, "validation_failed"),
      problem(409, "idempotency_conflict"),
      problem(409, "tool_bindings_changed"),
    ]) {
      expect(attemptAfterFailure({ key: "k1", state: "resend" }, refused)).toEqual({
        key: "k1",
        state: "reread",
      });
    }
  });

  test("an upload restart takes a new key even after a lost response", () => {
    const restart = problem(409, "brain_upload_restart");
    const lost = attemptAfterFailure({ key: "k1", state: "fresh" }, problem(502, "bad_gateway"));
    expect(lost).toEqual({ key: "k1", state: "resend" });
    for (const attempt of [lost, { key: "k1", state: "reread" } as const]) {
      const next = attemptAfterFailure(attempt, restart);
      expect(next.state).toBe("fresh");
      expect(next.key).not.toBe("k1");
    }
  });
});

describe("dialogLock", () => {
  const resend = { key: "k1", state: "resend" } as const;

  test("a keyed dialog without a caller's notice locks with the default notice", () => {
    expect(dialogLock("run", resend, undefined)).toEqual({
      kind: "locked",
      notice:
        "The platform may have applied this request. The fields stay locked, and submitting again repeats it under the same key. If it applied and this page's data has changed since, the platform refuses the repeat as a conflict. To change the request, choose Leave unfinished, check whether it applied, and open the dialog again to start a new request.",
    });
  });

  test("a keyed dialog keeps the caller's notice", () => {
    expect(dialogLock("run", resend, "Try again to finish this export.")).toEqual({
      kind: "locked",
      notice: "Try again to finish this export.",
    });
  });

  test("an unkeyed dialog never locks but refuses another submission after a lost response", () => {
    expect(dialogLock("runOnce", resend, "Try again to finish this export.")).toEqual({
      kind: "refused",
    });
    for (const state of ["fresh", "reread"] as const) {
      expect(dialogLock("runOnce", { key: "k1", state }, undefined)).toEqual({ kind: "editable" });
    }
  });

  test("fresh and reread attempts stay editable", () => {
    for (const state of ["fresh", "reread"] as const) {
      expect(dialogLock("run", { key: "k1", state }, undefined)).toEqual({ kind: "editable" });
      expect(dialogLock("run", { key: "k1", state }, "Try again.")).toEqual({ kind: "editable" });
    }
  });

  test("a lost response locks until a refusal turns the attempt into a reread", () => {
    const lost = attemptAfterFailure({ key: "k1", state: "fresh" }, problem(503, "unavailable"));
    expect(dialogLock("run", lost, undefined).kind).toBe("locked");
    const refused = attemptAfterFailure(lost, problem(409, "idempotency_conflict"));
    expect(dialogLock("run", refused, undefined)).toEqual({ kind: "editable" });
  });
});
