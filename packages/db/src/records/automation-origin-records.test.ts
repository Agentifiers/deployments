import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Ulid } from "../ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";

const id = (value: string) => Schema.decodeUnknownSync(Ulid)(value);
const scope = {
  environmentId: id("01ARZ3NDEKTSV4RRFFQ69G5FA0"),
  organizationId: id("01ARZ3NDEKTSV4RRFFQ69G5FA1"),
  projectId: id("01ARZ3NDEKTSV4RRFFQ69G5FA2"),
};
const agentDeploymentId = id("01ARZ3NDEKTSV4RRFFQ69G5FA3");
const timestamps = {
  createdAt: "2026-10-05T12:00:00.000Z",
  updatedAt: "2026-10-05T12:00:00.000Z",
  version: 0,
};

test("canonical decoding keeps the creator and originating tool call of automations", async () => {
  const schedule = await Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          ...scope,
          ...timestamps,
          agentDeploymentId,
          createdBy: { id: agentDeploymentId, type: "agent" as const },
          createdFrom: {
            runId: id("01ARZ3NDEKTSV4RRFFQ69G5FA4"),
            threadId: id("01ARZ3NDEKTSV4RRFFQ69G5FA5"),
            toolCallId: id("01ARZ3NDEKTSV4RRFFQ69G5FA6"),
            toolName: "agent.schedule.remind",
          },
          id: id("01ARZ3NDEKTSV4RRFFQ69G5FA7"),
          name: "Stretch reminder",
          schedule: { expression: "at(2026-10-05T12:03:00)", timezone: "UTC" },
          status: "active" as const,
        },
        itemType: "schedule" as const,
      }),
    ),
  );
  const heartbeat = await Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          ...scope,
          ...timestamps,
          agentDeploymentId,
          createdBy: { id: id("01ARZ3NDEKTSV4RRFFQ69G5FA8"), type: "service-account" as const },
          id: id("01ARZ3NDEKTSV4RRFFQ69G5FA9"),
          schedule: { instructions: "Reply ok.", intervalMs: 300_000, skipWhenBusy: true },
          status: "active" as const,
        },
        itemType: "heartbeat" as const,
      }),
    ),
  );

  expect(schedule.data).toMatchObject({
    createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5FA3", type: "agent" },
    createdFrom: {
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
      toolCallId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
      toolName: "agent.schedule.remind",
    },
  });
  expect(heartbeat.data).toMatchObject({
    createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5FA8", type: "service-account" },
  });
});
