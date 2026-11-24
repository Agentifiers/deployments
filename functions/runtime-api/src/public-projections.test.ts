import { expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  publicHeartbeat,
  publicMessagePublication,
  publicRun,
  publicSchedule,
} from "./public-projections.ts";

const scheduleId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const fireId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function run(data: Readonly<Record<string, unknown>>) {
  return { data, itemType: "run" } as unknown as Extract<
    PlatformRecord,
    { readonly itemType: "run" }
  >;
}

test("run projections name the automation fire that submitted the run", () => {
  const scheduled = run({
    idempotencyKey: `schedule:${scheduleId}:${fireId}`,
    trigger: "schedule",
  });

  expect(publicRun(scheduled).automation).toMatchObject({
    fireId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "schedule",
  });
  expect(publicRun(scheduled)).not.toHaveProperty("idempotencyKey");
  expect(
    publicRun(run({ idempotencyKey: `schedule:${scheduleId}:${fireId}`, trigger: "api" })),
  ).not.toHaveProperty("automation");
  expect(
    publicRun(
      run({
        idempotencyKey: `schedule:${scheduleId}:${fireId}`,
        replayedFromRunId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        trigger: "schedule",
      }),
    ),
  ).not.toHaveProperty("automation");
});

test("run projections omit organization admission bookkeeping", () => {
  expect<unknown>(
    publicRun(
      run({
        executionSlot: 3,
        idempotencyKey: "run/one",
        queuedAt: "2026-10-07T00:00:00.000Z",
        status: "running",
        trigger: "api",
      }),
    ),
  ).toEqual({
    checkpointCount: 0,
    executionPurpose: "customer",
    object: "run",
    status: "running",
    trigger: "api",
  });
});

test("run projections report the execution checkpoints the run took", () => {
  expect(publicRun(run({ checkpointCount: 3, idempotencyKey: "run/one" })).checkpointCount).toBe(3);
  expect(publicRun(run({ idempotencyKey: "run/one" })).checkpointCount).toBe(0);
});

test("automation projections redact internal timer activation state", () => {
  const scheduleConfiguration = {
    creationHash: "sha256:test",
    expression: "rate(1 hour)",
    timerActivationPending: true,
    timerActivationValidated: true,
    timerVersion: 1,
  };
  const schedule = {
    data: { schedule: scheduleConfiguration },
    itemType: "schedule",
  } as unknown as Extract<PlatformRecord, { readonly itemType: "schedule" }>;
  const heartbeat = {
    data: { schedule: { ...scheduleConfiguration, instructions: "Check in", intervalMs: 60_000 } },
    itemType: "heartbeat",
  } as unknown as Extract<PlatformRecord, { readonly itemType: "heartbeat" }>;

  expect(publicSchedule(schedule).schedule).toEqual({ expression: "rate(1 hour)" });
  expect(publicHeartbeat(heartbeat).schedule).toEqual({
    expression: "rate(1 hour)",
    instructions: "Check in",
    intervalMs: 60_000,
  });
});

test("message publication projections redact command and delivery evidence", () => {
  const publication = {
    data: {
      actor: { id: "service-account-1", type: "service-account" },
      commandHash: "command-hash",
      deliveredContentHash: "delivered-hash",
      id: "publication-1",
      safeContentHash: "safe-hash",
      status: "reserved",
    },
    itemType: "message-publication",
  } as unknown as Extract<PlatformRecord, { readonly itemType: "message-publication" }>;

  const projected = publicMessagePublication(publication);
  expect(projected).not.toHaveProperty("actor");
  expect(projected).not.toHaveProperty("commandHash");
  expect(projected).not.toHaveProperty("deliveredContentHash");
  expect(projected).not.toHaveProperty("safeContentHash");
  expect(projected).toMatchObject({
    id: publication.data.id,
    object: "message-publication",
    status: "reserved",
  });
});
