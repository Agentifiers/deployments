import { HeartbeatResponse, ScheduleResponse } from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  automationListing,
  keptLastFires,
  loadedRows,
  threadRefreshDelay,
  viewWindow,
  type AutomationListing,
  type AutomationPage,
  type AutomationView,
} from "./automation-listing.ts";
import {
  automationRecord,
  automationRow,
  type AutomationEntry,
  type AutomationFilters,
  type AutomationRow,
  type LastFire,
  type Schedule,
} from "./automation-state.ts";

const RUN = "01K0000000000000000000000R";
const THREAD = "01K0000000000000000000000T";
const OTHER_THREAD = "01K0000000000000000000000V";
const CALL = "01K0000000000000000000000C";
const FIRE_ID = "01K0000000000000000000000F";
const PRINCIPAL = "01K0000000000000000000000M";
const D1 = "01K000000000000000000000D1";
const D2 = "01K000000000000000000000D2";
const TENANT = {
  environmentId: "01K0000000000000000000000E",
  organizationId: "01K0000000000000000000000G",
  projectId: "01K0000000000000000000000J",
};
const NOW = new Date("2026-10-05T12:20:00.000Z");
const NEVER: LastFire = { kind: "never" };

type Fields = Readonly<Record<string, unknown>>;

const id = (index: number) => `01K0000000000000000000${String(index).padStart(4, "0")}`;

function schedule(
  index: number,
  name: string,
  status: Schedule["status"],
  fields: Fields = {},
): AutomationEntry {
  return {
    kind: "schedule",
    schedule: Schema.decodeUnknownSync(ScheduleResponse)({
      ...TENANT,
      agentDeploymentId: D1,
      createdAt: "2026-10-01T00:00:00.000Z",
      id: id(index),
      name,
      object: "schedule",
      schedule: { expression: "cron(0 9 * * ? *)", timezone: "UTC" },
      status,
      updatedAt: "2026-10-05T10:00:00.000Z",
      version: 1,
      ...fields,
    }),
  };
}

function heartbeat(index: number, instructions: string, fields: Fields = {}): AutomationEntry {
  return {
    heartbeat: Schema.decodeUnknownSync(HeartbeatResponse)({
      ...TENANT,
      agentDeploymentId: D1,
      createdAt: "2026-10-01T00:00:00.000Z",
      id: id(index),
      object: "heartbeat",
      schedule: { instructions, intervalMs: 1_800_000, skipWhenBusy: true },
      status: "active",
      updatedAt: "2026-10-05T12:00:00.000Z",
      version: 1,
      ...fields,
    }),
    kind: "heartbeat",
  };
}

const createdHere = (toolName: string) => ({
  createdFrom: { runId: RUN, threadId: THREAD, toolCallId: CALL, toolName },
});

const ENTRIES = [
  schedule(1, "Nightly report", "paused", { createdBy: { id: PRINCIPAL, type: "principal" } }),
  schedule(2, "Stretch reminder", "active", {
    ...createdHere("agent.schedule.remind"),
    schedule: { expression: "cron(40 12 * * ? *)", timezone: "UTC" },
    threadId: THREAD,
  }),
  heartbeat(3, "Queue check", {
    agentDeploymentId: D2,
    createdBy: { id: D2, type: "agent" },
    nextRunAt: "2026-10-05T12:30:00.000Z",
    threadId: OTHER_THREAD,
  }),
  schedule(4, "Status check-in", "active", {
    ...createdHere("agent.schedule.create"),
    schedule: { expression: "cron(0 0 1 1 ? 2032)", timezone: "UTC" },
  }),
  schedule(5, "Release notes", "provisioning", { agentDeploymentId: D2 }),
  schedule(6, "Old reminder", "archived", {
    ...createdHere("agent.schedule.remind"),
    threadId: THREAD,
  }),
];

const viewed = (listing: AutomationListing, view: AutomationView, offset = 0) => {
  const { records, ...rest } = viewWindow(listing, view, offset);
  return { ...rest, labels: records.map(({ label }) => label) };
};

describe("automationListing", () => {
  test("keeps one record per ID, the highest version, whichever page it came from", () => {
    const resumed = schedule(7, "Weekly digest", "active", { version: 3 });
    const paused = schedule(7, "Weekly digest", "paused", { version: 2 });
    const records = (entries: readonly AutomationEntry[]) =>
      automationListing(entries, NOW).records.map(({ id, status, version }) => ({
        id,
        status,
        version,
      }));
    expect(records([paused, resumed])).toEqual([{ id: id(7), status: "active", version: 3 }]);
    expect(records([resumed, paused])).toEqual([{ id: id(7), status: "active", version: 3 }]);
  });

  test("records the instant every row is judged at", () => {
    expect(automationListing([], NOW)).toEqual({
      listedAt: "2026-10-05T12:20:00.000Z",
      records: [],
    });
  });
});

describe("viewWindow for the list", () => {
  const listing = automationListing(ENTRIES, NOW);
  const list = (filters: AutomationFilters, deploymentIds?: readonly string[]): AutomationView => ({
    filters,
    kind: "list",
    ...(deploymentIds ? { deploymentIds } : {}),
  });
  const ACTIVE_FIRST = [
    "Queue check",
    "Stretch reminder",
    "Status check-in",
    "Release notes",
    "Nightly report",
  ];

  test("orders active by next fire, then provisioning, then paused, and hides archived", () => {
    expect(viewed(listing, list({}))).toEqual({ hidden: 1, labels: ACTIVE_FIRST });
  });

  test("show=all lists archived last and hides nothing", () => {
    expect(viewed(listing, list({ show: "all" }))).toEqual({
      hidden: 0,
      labels: [...ACTIVE_FIRST, "Old reminder"],
    });
  });

  test("filters keep only matching records and count only the matching archived ones as hidden", () => {
    expect(viewed(listing, list({ origin: "agent" }))).toEqual({
      hidden: 1,
      labels: ["Queue check", "Stretch reminder", "Status check-in"],
    });
    expect(viewed(listing, list({ origin: "caller" }))).toEqual({
      hidden: 0,
      labels: ["Nightly report"],
    });
    expect(viewed(listing, list({ kind: "heartbeat" }))).toEqual({
      hidden: 0,
      labels: ["Queue check"],
    });
    expect(viewed(listing, list({ agentDeploymentId: D2 }))).toEqual({
      hidden: 0,
      labels: ["Queue check", "Release notes"],
    });
  });

  test("the agent tab lists only its deployments' automations", () => {
    expect(viewed(listing, list({ show: "all" }, [D2]))).toEqual({
      hidden: 0,
      labels: ["Queue check", "Release notes"],
    });
  });

  test("a page holds 25 records from its offset, newest update first among equals, and points at the next page", () => {
    const many = automationListing(
      Array.from({ length: 27 }, (_, index) =>
        schedule(100 + index, `Paused ${index}`, "paused", {
          updatedAt: `2026-10-05T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
      NOW,
    );
    const { labels, ...first } = viewed(many, list({}));
    expect({ ...first, count: labels.length, first: labels[0], last: labels.at(-1) }).toEqual({
      count: 25,
      first: "Paused 26",
      hidden: 0,
      last: "Paused 2",
      nextOffset: 25,
    });
    expect(viewed(many, list({}), 25)).toEqual({ hidden: 0, labels: ["Paused 1", "Paused 0"] });
  });
});

describe("viewWindow for a thread", () => {
  test("lists records bound to the thread or created in it once each, in every status", () => {
    expect(viewed(automationListing(ENTRIES, NOW), { kind: "thread", threadId: THREAD })).toEqual({
      hidden: 0,
      labels: ["Stretch reminder", "Status check-in", "Old reminder"],
    });
  });

  test("pages 10 records at a time", () => {
    const listing = automationListing(
      Array.from({ length: 12 }, (_, index) =>
        schedule(200 + index, `Reminder ${index}`, "archived", {
          threadId: THREAD,
          updatedAt: `2026-10-05T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      ),
      NOW,
    );
    const view: AutomationView = { kind: "thread", threadId: THREAD };
    expect(viewed(listing, view).nextOffset).toBe(10);
    expect(viewed(listing, view, 10)).toEqual({ hidden: 0, labels: ["Reminder 1", "Reminder 0"] });
  });
});

describe("keptLastFires", () => {
  const fired: LastFire = {
    fire: {
      at: "2026-10-05T12:00:00.000Z",
      id: FIRE_ID,
      outcome: "started",
      runId: RUN,
      source: "unknown",
    },
    kind: "fired",
  };
  const shown = (entry: AutomationEntry, lastFire: LastFire) =>
    automationRow(automationRecord(entry), lastFire, NOW);

  test("keeps a heartbeat's and an archived schedule's fire at the same version and re-reads the rest", () => {
    const previous = [
      shown(heartbeat(1, "Queue check"), fired),
      shown(schedule(2, "Old reminder", "archived"), NEVER),
      shown(schedule(3, "Daily summary", "active"), fired),
      shown(heartbeat(4, "Inbox sweep"), fired),
      shown(heartbeat(5, "Status ping"), { kind: "unavailable" }),
    ];
    const records = [
      heartbeat(1, "Queue check"),
      schedule(2, "Old reminder", "archived"),
      schedule(3, "Daily summary", "active"),
      heartbeat(4, "Inbox sweep", { version: 2 }),
      heartbeat(5, "Status ping"),
    ].map(automationRecord);
    expect([...keptLastFires(previous, records)]).toEqual([
      [
        id(1),
        {
          fire: {
            at: "2026-10-05T12:00:00.000Z",
            id: FIRE_ID,
            outcome: "started",
            runId: RUN,
            source: "unknown",
          },
          kind: "fired",
        },
      ],
      [id(2), { kind: "never" }],
    ]);
  });
});

test("loadedRows keeps the first row of an ID a later page repeats", () => {
  const row = (entry: AutomationEntry) => automationRow(automationRecord(entry), NEVER, NOW);
  const pages: AutomationPage[] = [
    {
      hidden: 0,
      nextOffset: 2,
      rows: [
        row(schedule(1, "Daily summary", "active")),
        row(schedule(2, "Weekly digest", "active")),
      ],
    },
    {
      hidden: 0,
      rows: [
        row(schedule(2, "Weekly digest", "paused")),
        row(schedule(3, "Monthly close", "active")),
      ],
    },
  ];
  expect(loadedRows(pages).map(({ label, status }) => ({ label, status }))).toEqual([
    { label: "Daily summary", status: "active" },
    { label: "Weekly digest", status: "active" },
    { label: "Monthly close", status: "active" },
  ]);
});

describe("threadRefreshDelay", () => {
  const base = automationRow(automationRecord(schedule(1, "Daily summary", "paused")), NEVER, NOW);
  const firing = (at: string): AutomationRow => ({
    ...base,
    nextFire: { at, estimate: false, kind: "at" },
    status: "active",
  });

  test("waits until a minute after the earliest next fire", () => {
    const rows = [firing("2026-10-05T12:50:00.000Z"), firing("2026-10-05T12:24:00.000Z")];
    expect(threadRefreshDelay(rows, NOW)).toBe(300_000);
  });

  test("waits at least 30 seconds, even for a fire already due", () => {
    expect(threadRefreshDelay([firing("2026-10-05T12:00:00.000Z")], NOW)).toBe(30_000);
  });

  test("waits at most an hour", () => {
    expect(threadRefreshDelay([firing("2026-10-06T12:00:00.000Z")], NOW)).toBe(3_600_000);
  });

  test("polls every 30 seconds while a row provisions", () => {
    expect(threadRefreshDelay([base, { ...base, status: "provisioning" }], NOW)).toBe(30_000);
  });

  test("stops when no row has a next fire", () => {
    expect(threadRefreshDelay([base], NOW)).toBe(false);
    expect(threadRefreshDelay([], NOW)).toBe(false);
  });
});
