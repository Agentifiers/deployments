import {
  HeartbeatResponse,
  HeartbeatRunResponse,
  RuntimeActor,
  ScheduleCreatedFrom,
  ScheduleFireResponse,
  ScheduleResponse,
} from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  automationLabel,
  automationOrigin,
  automationPath,
  automationRecord,
  automationRow,
  availableActions,
  fireConsumesSchedule,
  fireRow,
  parseAutomationFilters,
  resumeBlockedReason,
  type AutomationAction,
  type AutomationEntry,
  type AutomationKind,
  type AutomationRow,
  type AutomationStatus,
  type LastFire,
  type Schedule,
} from "./automation-state.ts";

const RUN = "01K0000000000000000000000R";
const THREAD = "01K0000000000000000000000T";
const SCHEDULE_ID = "01K0000000000000000000000S";
const HEARTBEAT_ID = "01K0000000000000000000000H";
const FIRE_ID = "01K0000000000000000000000F";
const CALL = "01K0000000000000000000000C";
const ACCOUNT = "01K0000000000000000000000A";
const PRINCIPAL = "01K0000000000000000000000M";
const DEPLOYMENT = "01K000000000000000000000D1";
const TENANT = {
  environmentId: "01K0000000000000000000000E",
  organizationId: "01K0000000000000000000000G",
  projectId: "01K0000000000000000000000J",
};
const FAILED_REASON =
  "The schedule was not active, the fire was for an earlier version, the thread or workspace was unavailable, a spend budget refused the run, or the organization was suspended";

type Fields = Readonly<Record<string, unknown>>;

function scheduleEntry(
  status: Schedule["status"],
  expression: string,
  fields: Fields = {},
): AutomationEntry {
  const schedule = Schema.decodeUnknownSync(ScheduleResponse)({
    ...TENANT,
    agentDeploymentId: DEPLOYMENT,
    createdAt: "2026-10-01T00:00:00.000Z",
    id: SCHEDULE_ID,
    name: "Daily summary",
    object: "schedule",
    schedule: { expression, timezone: "UTC" },
    status,
    updatedAt: "2026-10-05T10:00:00.000Z",
    version: 1,
    ...fields,
  });
  return { kind: "schedule", schedule };
}

function heartbeatEntry(fields: Fields): AutomationEntry {
  const heartbeat = Schema.decodeUnknownSync(HeartbeatResponse)({
    ...TENANT,
    agentDeploymentId: DEPLOYMENT,
    createdAt: "2026-10-01T00:00:00.000Z",
    id: HEARTBEAT_ID,
    object: "heartbeat",
    schedule: { instructions: "Reply with ok.", intervalMs: 1_800_000, skipWhenBusy: true },
    version: 1,
    ...fields,
  });
  return { heartbeat, kind: "heartbeat" };
}

const scheduleFire = (fields: Fields) =>
  Schema.decodeUnknownSync(ScheduleFireResponse)({
    ...TENANT,
    createdAt: "2026-10-05T12:00:00.000Z",
    id: FIRE_ID,
    object: "schedule-fire",
    scheduleId: SCHEDULE_ID,
    ...fields,
  });

const heartbeatFire = (fields: Fields) =>
  Schema.decodeUnknownSync(HeartbeatRunResponse)({
    ...TENANT,
    createdAt: "2026-10-05T12:00:00.000Z",
    heartbeatId: HEARTBEAT_ID,
    id: FIRE_ID,
    object: "heartbeat-run",
    version: 0,
    ...fields,
  });

const NEVER: LastFire = { kind: "never" };
const timing = ({ health, nextFire }: AutomationRow) => ({ health, nextFire });

describe("fireRow", () => {
  test("an accepted timer fire started a run at its scheduled time", () => {
    const fire = scheduleFire({
      fireKey: "2026-10-05T12:00:00Z",
      firedAt: "2026-10-05T12:00:03.120Z",
      runId: RUN,
      status: "accepted",
      threadId: THREAD,
    });
    expect(fireRow("schedule", fire)).toEqual({
      at: "2026-10-05T12:00:03.120Z",
      id: FIRE_ID,
      outcome: "started",
      runId: RUN,
      scheduledFor: "2026-10-05T12:00:00Z",
      source: "timer",
      threadId: THREAD,
    });
  });

  test("a failed fire keyed by the caller is manual and names every possible cause", () => {
    const fire = scheduleFire({
      fireKey: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
      firedAt: "2026-10-05T12:01:00.000Z",
      status: "failed",
    });
    expect(fireRow("schedule", fire)).toEqual({
      at: "2026-10-05T12:01:00.000Z",
      id: FIRE_ID,
      outcome: "not-started",
      reason: FAILED_REASON,
      source: "manual",
    });
  });

  test("a duplicate started a run only when it carries one", () => {
    const outcome = (fields: Fields) => {
      const { outcome, reason } = fireRow(
        "schedule",
        scheduleFire({ fireKey: "k", firedAt: "2026-10-05T12:01:00.000Z", ...fields }),
      );
      return { outcome, reason };
    };
    expect(outcome({ runId: RUN, status: "duplicate", threadId: THREAD })).toEqual({
      outcome: "started",
      reason: undefined,
    });
    expect(outcome({ status: "duplicate" })).toEqual({
      outcome: "not-started",
      reason: "Duplicate of an earlier fire",
    });
  });

  test("a heartbeat skip reads its reason in plain words and has no known source", () => {
    const skipped = (skipReason: string) =>
      fireRow("heartbeat", heartbeatFire({ skipReason, status: "skipped" }));
    expect(skipped("outside-active-window")).toEqual({
      at: "2026-10-05T12:00:00.000Z",
      id: FIRE_ID,
      outcome: "skipped",
      reason: "Outside the active window",
      source: "unknown",
    });
    expect(skipped("organization-suspended").reason).toBe("The organization was suspended");
    expect(skipped("quota").reason).toBe("quota");
  });
});

describe("automationOrigin", () => {
  const actor = Schema.decodeUnknownSync(RuntimeActor);

  test("a recorded tool call is the agent tool that created the automation", () => {
    const createdFrom = Schema.decodeUnknownSync(ScheduleCreatedFrom)({
      runId: RUN,
      threadId: THREAD,
      toolCallId: CALL,
      toolName: "agent.schedule.remind",
    });
    expect(automationOrigin({ createdFrom })).toEqual({
      kind: "agent-tool",
      runId: RUN,
      threadId: THREAD,
      toolName: "agent.schedule.remind",
    });
  });

  test("any recorded creator without a tool call is a caller", () => {
    expect(
      automationOrigin({ createdBy: actor({ id: ACCOUNT, type: "service-account" }) }),
    ).toEqual({ actorId: ACCOUNT, actorType: "service-account", kind: "caller" });
    expect(automationOrigin({ createdBy: actor({ id: DEPLOYMENT, type: "agent" }) })).toEqual({
      actorId: DEPLOYMENT,
      actorType: "agent",
      kind: "caller",
    });
    expect(automationOrigin({ createdBy: actor({ type: "system" }) })).toEqual({
      actorType: "system",
      kind: "caller",
    });
  });

  test("no creator is unrecorded", () => {
    expect(automationOrigin({})).toEqual({ kind: "unrecorded" });
  });
});

describe("availableActions", () => {
  const STATUSES: readonly AutomationStatus[] = [
    "active",
    "archived",
    "disabled",
    "paused",
    "provisioning",
  ];
  const READER = {
    archiveHeartbeat: false,
    archiveSchedule: false,
    fireHeartbeat: false,
    fireSchedule: false,
    pauseHeartbeat: false,
    pauseSchedule: false,
    resumeHeartbeat: false,
    resumeSchedule: false,
  };
  const WRITER = {
    archiveHeartbeat: true,
    archiveSchedule: true,
    fireHeartbeat: true,
    fireSchedule: true,
    pauseHeartbeat: true,
    pauseSchedule: true,
    resumeHeartbeat: true,
    resumeSchedule: true,
  };
  const offered = (kind: AutomationKind) =>
    Object.fromEntries(
      STATUSES.map((status) => [status, availableActions({ kind, status }, WRITER)]),
    );

  test("STATUS_ACTIONS: with schedules:write each status offers its lifecycle actions", () => {
    const expected: Readonly<Record<AutomationStatus, readonly AutomationAction[]>> = {
      active: ["fire", "pause", "archive"],
      archived: [],
      disabled: [],
      paused: ["resume", "archive"],
      provisioning: ["resume", "pause", "archive"],
    };
    expect(offered("schedule")).toEqual(expected);
    expect(offered("heartbeat")).toEqual(expected);
  });

  test("without schedules:write no action is offered", () => {
    expect(availableActions({ kind: "schedule", status: "active" }, READER)).toEqual([]);
    expect(availableActions({ kind: "heartbeat", status: "provisioning" }, READER)).toEqual([]);
  });

  test("each action needs its own kind's operation", () => {
    const access = { ...READER, fireHeartbeat: true, pauseSchedule: true };
    expect(availableActions({ kind: "schedule", status: "active" }, access)).toEqual(["pause"]);
  });
});

describe("one-time schedules", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  const row = (status: Schedule["status"], expression: string) =>
    automationRow(automationRecord(scheduleEntry(status, expression)), NEVER, now);

  test("fireConsumesSchedule: only an active at() schedule is consumed by firing it", () => {
    expect(fireConsumesSchedule(row("active", "at(2026-11-02T09:00:00)"))).toBe(true);
    expect(fireConsumesSchedule(row("active", "cron(0 9 * * ? *)"))).toBe(false);
    expect(fireConsumesSchedule(row("paused", "at(2026-11-02T09:00:00)"))).toBe(false);
  });

  test("resumeBlockedReason: a paused or provisioning at() schedule whose time has passed cannot resume", () => {
    const blocked =
      "The one-time time has passed, so this schedule cannot fire again. Archive it instead.";
    expect(resumeBlockedReason(row("paused", "at(2026-10-05T11:00:00)"), now)).toBe(blocked);
    expect(resumeBlockedReason(row("provisioning", "at(2026-10-05T11:00:00)"), now)).toBe(blocked);
    expect(resumeBlockedReason(row("paused", "at(2026-11-02T09:00:00)"), now)).toBeUndefined();
    expect(
      resumeBlockedReason(row("provisioning", "at(2026-11-02T09:00:00)"), now),
    ).toBeUndefined();
    expect(resumeBlockedReason(row("paused", "cron(0 9 * * ? *)"), now)).toBeUndefined();
  });
});

describe("automationRow", () => {
  test("normalizes a heartbeat into one list row", () => {
    const fire = fireRow(
      "heartbeat",
      heartbeatFire({ runId: RUN, status: "accepted", threadId: THREAD }),
    );
    const entry = heartbeatEntry({
      activeWindow: { daysOfWeek: [1, 2, 3, 4, 5], endMinuteOfDay: 1020, startMinuteOfDay: 540 },
      createdBy: { id: PRINCIPAL, type: "principal" },
      nextRunAt: "2026-10-05T12:30:00.000Z",
      schedule: {
        instructions: "Check the queue.",
        intervalMs: 1_800_000,
        skipWhenBusy: false,
        timezone: "Europe/Berlin",
      },
      status: "active",
      threadId: THREAD,
      updatedAt: "2026-10-05T12:00:00.000Z",
    });
    expect(
      automationRow(
        automationRecord(entry),
        { fire, kind: "fired" },
        new Date("2026-10-05T12:05:00.000Z"),
      ),
    ).toEqual({
      agentDeploymentId: DEPLOYMENT,
      cadence: {
        intervalMs: 1_800_000,
        kind: "heartbeat",
        skipWhenBusy: false,
        timeZone: "Europe/Berlin",
        window: { daysOfWeek: [1, 2, 3, 4, 5], endMinuteOfDay: 1020, startMinuteOfDay: 540 },
      },
      health: { kind: "ok" },
      id: HEARTBEAT_ID,
      kind: "heartbeat",
      label: "Check the queue.",
      lastFire: {
        fire: {
          at: "2026-10-05T12:00:00.000Z",
          id: FIRE_ID,
          outcome: "started",
          runId: RUN,
          source: "unknown",
          threadId: THREAD,
        },
        kind: "fired",
      },
      nextFire: { at: "2026-10-05T12:30:00.000Z", estimate: false, kind: "at" },
      nextRunAt: "2026-10-05T12:30:00.000Z",
      origin: { actorId: PRINCIPAL, actorType: "principal", kind: "caller" },
      status: "active",
      thread: { kind: "continues", threadId: THREAD },
      updatedAt: "2026-10-05T12:00:00.000Z",
      version: 1,
    });
  });

  const heartbeatAt = (nextRunAt: string, updatedAt: string, now: string) =>
    timing(
      automationRow(
        automationRecord(heartbeatEntry({ nextRunAt, status: "active", updatedAt })),
        NEVER,
        new Date(now),
      ),
    );

  test("a heartbeat resumed after its stored next run expects a fire one interval after the resume", () => {
    expect(
      heartbeatAt(
        "2026-10-05T12:00:00.000Z",
        "2026-10-05T12:20:00.000Z",
        "2026-10-05T12:25:00.000Z",
      ),
    ).toEqual({
      health: { kind: "ok" },
      nextFire: { at: "2026-10-05T12:50:00.000Z", estimate: false, kind: "at" },
    });
  });

  test("a heartbeat more than 10 minutes past its expected fire is flagged and its next fire estimated", () => {
    expect(
      heartbeatAt(
        "2026-10-05T12:00:00.000Z",
        "2026-10-05T11:30:00.000Z",
        "2026-10-05T12:15:00.000Z",
      ),
    ).toEqual({
      health: { expectedAt: "2026-10-05T12:00:00.000Z", kind: "missed-fire" },
      nextFire: { at: "2026-10-05T12:30:00.000Z", estimate: true, kind: "at" },
    });
  });

  test("provisioning for more than 5 minutes is stuck", () => {
    const provisioning = (updatedAt: string) =>
      timing(
        automationRow(
          automationRecord(heartbeatEntry({ status: "provisioning", updatedAt })),
          NEVER,
          new Date("2026-10-05T12:00:00.000Z"),
        ),
      );
    expect(provisioning("2026-10-05T11:54:00.000Z")).toEqual({
      health: { kind: "stuck-provisioning", since: "2026-10-05T11:54:00.000Z" },
      nextFire: { kind: "none", reason: "inactive" },
    });
    expect(provisioning("2026-10-05T11:57:00.000Z").health).toEqual({ kind: "ok" });
  });

  test("a last fire that started no run is flagged unless the heartbeat's settings skipped it", () => {
    const health = (skipReason: string) =>
      automationRow(
        automationRecord(
          heartbeatEntry({
            nextRunAt: "2026-10-05T12:30:00.000Z",
            status: "active",
            updatedAt: "2026-10-05T12:00:00.000Z",
          }),
        ),
        {
          fire: fireRow("heartbeat", heartbeatFire({ skipReason, status: "skipped" })),
          kind: "fired",
        },
        new Date("2026-10-05T12:05:00.000Z"),
      ).health;
    expect(health("budget-exhausted")).toEqual({
      at: "2026-10-05T12:00:00.000Z",
      kind: "last-fire-without-run",
    });
    expect(health("busy")).toEqual({ kind: "ok" });
    expect(health("outside-active-window")).toEqual({ kind: "ok" });
  });

  test("archived and disabled automations report ok even when their last fire started no run", () => {
    const statuses: AutomationStatus[] = ["active", "archived", "disabled"];
    const health = statuses.map((status) => [
      status,
      automationRow(
        automationRecord(
          heartbeatEntry({
            nextRunAt: "2026-10-05T12:30:00.000Z",
            status,
            updatedAt: "2026-10-05T12:00:00.000Z",
          }),
        ),
        {
          fire: fireRow(
            "heartbeat",
            heartbeatFire({ skipReason: "budget-exhausted", status: "skipped" }),
          ),
          kind: "fired",
        },
        new Date("2026-10-05T12:05:00.000Z"),
      ).health,
    ]);
    expect(health).toEqual([
      ["active", { at: "2026-10-05T12:00:00.000Z", kind: "last-fire-without-run" }],
      ["archived", { kind: "ok" }],
      ["disabled", { kind: "ok" }],
    ]);
  });

  test("a rate() schedule with no timer fire yet estimates from its last update and flags the missed first fire", () => {
    const row = automationRow(
      automationRecord(
        scheduleEntry("active", "rate(10 minutes)", { updatedAt: "2026-10-05T12:00:00.000Z" }),
      ),
      NEVER,
      new Date("2026-10-05T12:34:00.000Z"),
    );
    expect(timing(row)).toEqual({
      health: { expectedAt: "2026-10-05T12:10:00.000Z", kind: "missed-fire" },
      nextFire: { at: "2026-10-05T12:40:00.000Z", estimate: true, kind: "at" },
    });
  });

  test("a schedule resumed after a long pause expects its next fire after the resume, not after the last fire", () => {
    const fire = fireRow(
      "schedule",
      scheduleFire({
        fireKey: "2026-10-04T12:00:00Z",
        firedAt: "2026-10-04T12:00:01.000Z",
        runId: RUN,
        status: "accepted",
        threadId: THREAD,
      }),
    );
    const row = automationRow(
      automationRecord(
        scheduleEntry("active", "rate(10 minutes)", { updatedAt: "2026-10-05T12:30:00.000Z" }),
      ),
      { fire, kind: "fired" },
      new Date("2026-10-05T12:34:00.000Z"),
    );
    expect(timing(row)).toEqual({
      health: { kind: "ok" },
      nextFire: { at: "2026-10-05T12:40:00.000Z", estimate: false, kind: "at" },
    });
  });

  test("a schedule with no fire left or an expression the console cannot read has no next fire", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const scheduleTiming = (expression: string) =>
      timing(automationRow(automationRecord(scheduleEntry("active", expression)), NEVER, now));
    expect(scheduleTiming("at(2026-10-05T11:00:00)")).toEqual({
      health: { expectedAt: "2026-10-05T11:00:00.000Z", kind: "missed-fire" },
      nextFire: { kind: "none", reason: "passed" },
    });
    expect(scheduleTiming("cron(0 0 1 1 ? 2032)")).toEqual({
      health: { kind: "ok" },
      nextFire: { kind: "none", reason: "beyond-horizon" },
    });
    expect(scheduleTiming("every day")).toEqual({
      health: { kind: "ok" },
      nextFire: { kind: "none", reason: "unparsed" },
    });
  });

  test("an unavailable last fire anchors no rate, flags no fire without a run, and calls no fire missed", () => {
    const entry = scheduleEntry("active", "rate(10 minutes)", {
      updatedAt: "2026-10-05T12:00:00.000Z",
    });
    const now = new Date("2026-10-05T12:34:00.000Z");
    const judged = (lastFire: LastFire) =>
      timing(automationRow(automationRecord(entry), lastFire, now));
    const failed = fireRow(
      "schedule",
      scheduleFire({
        fireKey: "2026-10-05T12:25:00Z",
        firedAt: "2026-10-05T12:25:02.000Z",
        status: "failed",
      }),
    );
    expect(judged({ fire: failed, kind: "fired" })).toEqual({
      health: { at: "2026-10-05T12:25:02.000Z", kind: "last-fire-without-run" },
      nextFire: { at: "2026-10-05T12:35:00.000Z", estimate: false, kind: "at" },
    });
    expect(judged(NEVER)).toEqual({
      health: { expectedAt: "2026-10-05T12:10:00.000Z", kind: "missed-fire" },
      nextFire: { at: "2026-10-05T12:40:00.000Z", estimate: true, kind: "at" },
    });
    expect(judged({ kind: "unavailable" })).toEqual({
      health: { kind: "ok" },
      nextFire: { at: "2026-10-05T12:40:00.000Z", estimate: true, kind: "at" },
    });
  });
});

test("automationRecord keeps what the views read, without the prompt or the instructions, and a schedule's expression as text", () => {
  const expression = "cron(30 9 ? * MON-FRI *)";
  const schedule = scheduleEntry("active", expression, {
    createdFrom: {
      runId: RUN,
      threadId: THREAD,
      toolCallId: CALL,
      toolName: "agent.schedule.remind",
    },
    prompt: "Summarize the day. ".repeat(106).slice(0, 2_000),
    schedule: { expression, timezone: "America/Los_Angeles" },
    threadId: THREAD,
    version: 4,
  });
  const heartbeat = heartbeatEntry({
    activeWindow: { daysOfWeek: [1, 2, 3, 4, 5], endMinuteOfDay: 1020, startMinuteOfDay: 540 },
    createdBy: { id: PRINCIPAL, type: "principal" },
    nextRunAt: "2026-10-05T12:30:00.000Z",
    schedule: {
      instructions:
        "Post a digest of the deploys that failed in the last half hour to the release channel.\nSkip the post when none failed.\n",
      intervalMs: 1_800_000,
      skipWhenBusy: true,
      timezone: "Europe/Berlin",
    },
    status: "active",
    updatedAt: "2026-10-05T12:00:00.000Z",
  });
  expect(automationRecord(schedule)).toEqual({
    agentDeploymentId: DEPLOYMENT,
    cadence: { kind: "schedule", raw: "cron(30 9 ? * MON-FRI *)", timeZone: "America/Los_Angeles" },
    id: SCHEDULE_ID,
    kind: "schedule",
    label: "Daily summary",
    origin: { kind: "agent-tool", runId: RUN, threadId: THREAD, toolName: "agent.schedule.remind" },
    status: "active",
    thread: { kind: "continues", threadId: THREAD },
    updatedAt: "2026-10-05T10:00:00.000Z",
    version: 4,
  });
  expect(automationRecord(heartbeat)).toEqual({
    agentDeploymentId: DEPLOYMENT,
    cadence: {
      intervalMs: 1_800_000,
      kind: "heartbeat",
      skipWhenBusy: true,
      timeZone: "Europe/Berlin",
      window: { daysOfWeek: [1, 2, 3, 4, 5], endMinuteOfDay: 1020, startMinuteOfDay: 540 },
    },
    id: HEARTBEAT_ID,
    kind: "heartbeat",
    label: "Post a digest of the deploys that failed in the last half h…",
    nextRunAt: "2026-10-05T12:30:00.000Z",
    origin: { actorId: PRINCIPAL, actorType: "principal", kind: "caller" },
    status: "active",
    thread: { kind: "new-thread-per-fire" },
    updatedAt: "2026-10-05T12:00:00.000Z",
    version: 1,
  });
});

describe("automationLabel", () => {
  test("a schedule is labelled by its name", () => {
    expect(automationLabel(scheduleEntry("active", "rate(1 day)"))).toBe("Daily summary");
  });

  test("a heartbeat is labelled by the first line of its instructions, cut to 60 characters", () => {
    const entry = heartbeatEntry({
      schedule: {
        instructions:
          "\n\n   Check the build queue for runs stuck longer than one hour and post a summary.  \nInclude run IDs.\n",
        intervalMs: 1_800_000,
        skipWhenBusy: true,
      },
      status: "active",
      updatedAt: "2026-10-05T12:00:00.000Z",
    });
    expect(automationLabel(entry)).toBe(
      "Check the build queue for runs stuck longer than one hour a…",
    );
  });
});

test("parseAutomationFilters keeps known values and drops the rest", () => {
  expect(parseAutomationFilters({ kind: "x", show: "all" })).toEqual({ show: "all" });
  expect(
    parseAutomationFilters({
      agentDeploymentId: DEPLOYMENT,
      kind: "heartbeat",
      origin: "agent",
      show: "all",
    }),
  ).toEqual({ agentDeploymentId: DEPLOYMENT, kind: "heartbeat", origin: "agent", show: "all" });
  expect(
    parseAutomationFilters({ agentDeploymentId: "D2", origin: "system", show: "archived" }),
  ).toEqual({});
});

test("automationPath links into the environment by kind", () => {
  const scope = { environmentId: "E1", organizationId: "O1", projectId: "P1" };
  expect(automationPath(scope, { id: "H1", kind: "heartbeat" })).toBe(
    "/o/O1/p/P1/e/E1/automations/heartbeats/H1",
  );
  expect(automationPath(scope, { id: "S1", kind: "schedule" })).toBe(
    "/o/O1/p/P1/e/E1/automations/schedules/S1",
  );
});
