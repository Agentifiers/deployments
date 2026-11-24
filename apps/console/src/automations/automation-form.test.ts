import {
  CreateHeartbeatRequest,
  CreateScheduleRequest,
  HeartbeatResponse,
  ScheduleResponse,
} from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  checkHeartbeatCreate,
  checkHeartbeatEdit,
  checkScheduleCreate,
  checkScheduleEdit,
  heartbeatEditDraft,
  newHeartbeatDraft,
  newScheduleDraft,
  scheduleEditDraft,
} from "./automation-form.ts";

const DEPLOYMENT = "01K000000000000000000000D1";
const TENANT = {
  createdAt: "2026-10-01T00:00:00.000Z",
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 2,
};

const schedule = Schema.decodeUnknownSync(ScheduleResponse)({
  ...TENANT,
  agentDeploymentId: DEPLOYMENT,
  id: "01K0000000000000000000000S",
  name: "Nightly digest",
  object: "schedule",
  prompt: "Summarize the day.",
  schedule: { expression: "cron(0 2 * * ? *)", timezone: "Europe/Berlin" },
  status: "paused",
});

const heartbeat = Schema.decodeUnknownSync(HeartbeatResponse)({
  ...TENANT,
  activeWindow: { daysOfWeek: [1, 2, 3, 4, 5], endMinuteOfDay: 1_440, startMinuteOfDay: 540 },
  agentDeploymentId: DEPLOYMENT,
  id: "01K0000000000000000000000H",
  object: "heartbeat",
  schedule: { instructions: "Check the queue.", intervalMs: 900_000, skipWhenBusy: true },
  status: "active",
});

describe("schedule form", () => {
  test("builds a create body the contract accepts, with a far-future one-time fire", () => {
    const check = checkScheduleCreate({
      ...newScheduleDraft("UTC"),
      agentDeploymentId: DEPLOYMENT,
      cadence: { kind: "at", wallTime: "2099-01-01T09:00" },
      name: " aaas-check ",
      prompt: "Say hello.",
    });
    expect(check).toEqual({
      body: {
        agentDeploymentId: DEPLOYMENT,
        expression: "at(2099-01-01T09:00:00)",
        name: "aaas-check",
        prompt: "Say hello.",
        timezone: "UTC",
      },
      kind: "ready",
    });
    if (check.kind === "ready") {
      expect(() => Schema.decodeUnknownSync(CreateScheduleRequest)(check.body)).not.toThrow();
    }
  });

  test("names the first invalid field", () => {
    const draft = { ...newScheduleDraft("UTC"), agentDeploymentId: DEPLOYMENT, name: "x" };
    expect(checkScheduleCreate({ ...draft, prompt: "p", timezone: "Mars/Base" })).toEqual({
      field: "timezone",
      kind: "invalid",
    });
    expect(
      checkScheduleCreate({
        ...draft,
        cadence: { fields: "0 9 * * * *", kind: "cron" },
        prompt: "p",
      }),
    ).toEqual({ field: "cadence", kind: "invalid" });
  });

  test("an edit sends only the fields it changed and nothing when it changed none", () => {
    const opened = scheduleEditDraft(schedule);
    expect(checkScheduleEdit(schedule, opened)).toEqual({ kind: "unchanged" });
    expect(
      checkScheduleEdit(schedule, {
        ...opened,
        cadence: { every: "2", kind: "rate", unit: "hour" },
      }),
    ).toEqual({ body: { expression: "rate(2 hours)" }, kind: "ready" });
  });
});

describe("heartbeat form", () => {
  test("builds a create body the contract accepts", () => {
    const check = checkHeartbeatCreate({
      ...newHeartbeatDraft("UTC"),
      agentDeploymentId: DEPLOYMENT,
      instructions: "Ping.",
      intervalMinutes: "1440",
      window: { days: [6, 0], enabled: true, end: "00:00", start: "22:00" },
    });
    expect(check).toEqual({
      body: {
        activeWindow: { daysOfWeek: [0, 6], endMinuteOfDay: 1_440, startMinuteOfDay: 1_320 },
        agentDeploymentId: DEPLOYMENT,
        instructions: "Ping.",
        intervalMs: 86_400_000,
        skipWhenBusy: true,
        timezone: "UTC",
      },
      kind: "ready",
    });
    if (check.kind === "ready") {
      expect(() => Schema.decodeUnknownSync(CreateHeartbeatRequest)(check.body)).not.toThrow();
    }
  });

  test("an edit that turns the window off clears it", () => {
    const opened = heartbeatEditDraft(heartbeat);
    expect(checkHeartbeatEdit(heartbeat, opened)).toEqual({ kind: "unchanged" });
    expect(
      checkHeartbeatEdit(heartbeat, { ...opened, window: { ...opened.window, enabled: false } }),
    ).toEqual({ body: { activeWindow: null }, kind: "ready" });
  });
});
