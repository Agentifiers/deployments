import { describe, expect, test } from "bun:test";
import {
  instantInput,
  keyedInput,
  keyedInputAt,
  pageInput,
  pageInputAt,
  scopedInput,
} from "./server-input.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G6002",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G6003",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G6004",
};
const runId = "01ARZ3NDEKTSV4RRFFQ69G6005";

describe("server function input", () => {
  test("keeps only the scope and the named IDs", () => {
    expect(scopedInput({ extra: "dropped", runId, scope }, ["runId"])).toEqual({ runId, scope });
    expect(() => scopedInput({ runId: "run-1", scope }, ["runId"])).toThrow(
      "runId must be a ULID.",
    );
    expect(() => scopedInput({ scope: { ...scope, projectId: "" } })).toThrow(
      "projectId must be a ULID.",
    );
  });

  test("requires the dialog's idempotency key on keyed mutations", () => {
    expect(keyedInput({ idempotencyKey: "key-1", runId, scope }, ["runId"])).toEqual({
      idempotencyKey: "key-1",
      runId,
      scope,
    });
    expect(() => keyedInput({ scope })).toThrow(
      "idempotencyKey must be a non-empty string of at most 512 characters.",
    );
  });

  test("accepts a list cursor of 1 to 8192 characters", () => {
    expect(pageInput({ scope })).toEqual({ scope });
    expect(pageInput({ cursor: "c".repeat(8_192), scope })).toEqual({
      cursor: "c".repeat(8_192),
      scope,
    });
    for (const cursor of ["", "c".repeat(8_193), 7]) {
      expect(() => pageInput({ cursor, scope })).toThrow(
        "cursor must be a non-empty string of at most 8192 characters.",
      );
    }
  });

  test("keeps only the scope fields of an organization- or project-level route", () => {
    expect(keyedInputAt("project", { idempotencyKey: "k", scope })).toEqual({
      idempotencyKey: "k",
      scope: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G6003",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G6004",
      },
    });
    expect(keyedInputAt("none", { idempotencyKey: "k" })).toEqual({
      idempotencyKey: "k",
      scope: {},
    });
    expect(
      keyedInputAt("organization", { idempotencyKey: "k", principalId: runId, scope }, [
        "principalId",
      ]),
    ).toEqual({
      idempotencyKey: "k",
      principalId: runId,
      scope: { organizationId: "01ARZ3NDEKTSV4RRFFQ69G6003" },
    });
    expect(pageInputAt("organization", { cursor: "c", scope })).toEqual({
      cursor: "c",
      scope: { organizationId: "01ARZ3NDEKTSV4RRFFQ69G6003" },
    });
    expect(() => keyedInputAt("project", { idempotencyKey: "k", scope: {} })).toThrow(
      "organizationId must be a ULID.",
    );
  });

  test("accepts only canonical UTC instants", () => {
    expect(instantInput("2026-10-07T12:00:00.000Z", "since")).toBe("2026-10-07T12:00:00.000Z");
    for (const value of [
      "2026-10-07T12:00:00Z",
      "2026-10-07T14:00:00.000+02:00",
      "2026-10-07",
      "2026-02-30T00:00:00.000Z",
      "yesterday",
      1_791_374_400_000,
      undefined,
    ]) {
      expect(() => instantInput(value, "since")).toThrow("since must be an ISO 8601 UTC instant.");
    }
  });
});
