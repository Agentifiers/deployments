import { expect, test } from "bun:test";
import { brainSyncEventDetail } from "./sync-dispatcher-main.ts";

test("Brain sync dispatch unwraps the EventBridge detail envelope", () => {
  const detail = {
    eventId: "event-1",
    organizationId: "organization-1",
    payload: {
      brainId: "brain-1",
      sourceId: "source-1",
      syncJobId: "job-1",
      syncJobIdempotencyKey: "source-1:sync",
    },
  };
  expect(brainSyncEventDetail({ detail })).toBe(detail);
});
