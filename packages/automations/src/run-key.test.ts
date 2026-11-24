import { expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { automationRunIdempotencyKey, parseAutomationRunIdempotencyKey } from "./run-key.ts";

const scheduleId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const fireId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;

test("encodes a schedule fire as the run idempotency key and parses it back", () => {
  const key = automationRunIdempotencyKey({ fireId, id: scheduleId, kind: "schedule" });

  expect(key).toBe("schedule:01ARZ3NDEKTSV4RRFFQ69G5FAV:01ARZ3NDEKTSV4RRFFQ69G5FAW");
  expect(parseAutomationRunIdempotencyKey(key)).toMatchObject({
    fireId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "schedule",
  });
});

test("parses heartbeat keys and rejects keys that no automation fire writes", () => {
  expect(
    parseAutomationRunIdempotencyKey(
      "heartbeat:01ARZ3NDEKTSV4RRFFQ69G5FAV:01ARZ3NDEKTSV4RRFFQ69G5FAW",
    ),
  ).toMatchObject({
    fireId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "heartbeat",
  });
  expect(parseAutomationRunIdempotencyKey("api-123")).toBeUndefined();
  expect(
    parseAutomationRunIdempotencyKey(
      "webhook:01ARZ3NDEKTSV4RRFFQ69G5FAV:01ARZ3NDEKTSV4RRFFQ69G5FAW",
    ),
  ).toBeUndefined();
  expect(
    parseAutomationRunIdempotencyKey("schedule:not-an-id:01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  ).toBeUndefined();
  expect(
    parseAutomationRunIdempotencyKey(
      "schedule:01ARZ3NDEKTSV4RRFFQ69G5FAV:01ARZ3NDEKTSV4RRFFQ69G5FAW:extra",
    ),
  ).toBeUndefined();
});
