import { MonitorResponse } from "@deployments-ai/api-contract/monitors";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  checkCondition,
  checkCreate,
  checkUpdate,
  monitorActions,
  monitorDraft,
  monitorState,
  MONITOR_KINDS,
  newMonitorDraft,
  type MonitorDraft,
} from "./monitor-model.ts";

const ORG = "01K000000000000000000000G1";
const PROJECT = "01K000000000000000000000J1";
const ENVIRONMENT = "01K000000000000000000000E1";
const MONITOR = "01K000000000000000000000M1";
const NOW = new Date("2026-11-03T10:00:00.000Z");

const monitor = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(MonitorResponse)({
    condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
    createdAt: NOW.toISOString(),
    environmentId: ENVIRONMENT,
    id: MONITOR,
    name: "Checkout failing",
    notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
    organizationId: ORG,
    projectId: PROJECT,
    state: "ok",
    status: "active",
    updatedAt: NOW.toISOString(),
    version: 4,
    ...overrides,
  });

const projectOf = (id: string) => (id === ENVIRONMENT ? PROJECT : undefined);

describe("monitor drafts", () => {
  test("every kind's starting draft is a condition the contract accepts", () => {
    for (const kind of MONITOR_KINDS) {
      expect({ kind, ok: checkCondition(newMonitorDraft(kind, ENVIRONMENT)).ok }).toEqual({
        kind,
        ok: true,
      });
    }
  });

  test("a value outside the contract's bounds names the field and the bound", () => {
    const draft = newMonitorDraft("run-failures", ENVIRONMENT);
    expect(checkCondition({ ...draft, values: { ...draft.values, windowMinutes: "2" } })).toEqual({
      field: "windowMinutes",
      message: "The window must be at least 5.",
      ok: false,
    });
    expect(checkCondition({ ...draft, values: { ...draft.values, threshold: "" } })).toMatchObject({
      field: "threshold",
      ok: false,
    });
  });

  test("empty optional fields are left out and filled ones are sent", () => {
    const draft = newMonitorDraft("tool-failures", ENVIRONMENT);
    expect(checkCondition(draft)).toEqual({
      body: { kind: "tool-failures", threshold: 3, windowMinutes: 15 },
      ok: true,
    });
    expect(
      checkCondition({ ...draft, values: { ...draft.values, toolName: " search " } }),
    ).toMatchObject({ body: { toolName: "search" }, ok: true });
  });

  test("an environment monitor is created in the environment's project", () => {
    const draft: MonitorDraft = { ...newMonitorDraft("run-failures", ENVIRONMENT), name: "Runs" };
    expect(checkCreate(draft, projectOf)).toEqual({
      body: {
        condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
        environmentId: ENVIRONMENT,
        name: "Runs",
        notify: { emailPrincipalIds: [], emailRoles: ["owner", "admin"], webhooks: true },
        projectId: PROJECT,
      },
      ok: true,
    });
    expect(checkCreate({ ...draft, environmentId: "" }, projectOf)).toMatchObject({
      field: "environmentId",
      ok: false,
    });
  });

  test("an organization monitor names no environment and emails billing by default", () => {
    const draft = { ...newMonitorDraft("budget-threshold", ENVIRONMENT), name: "Spend" };
    expect(checkCreate(draft, projectOf)).toEqual({
      body: {
        condition: { kind: "budget-threshold", minimumThreshold: 80 },
        name: "Spend",
        notify: {
          emailPrincipalIds: [],
          emailRoles: ["owner", "admin", "billing"],
          webhooks: false,
        },
      },
      ok: true,
    });
  });

  test("an edit sends the whole configuration at the version it opened on", () => {
    const current = monitor({ renotifyMinutes: 60 });
    const draft = { ...monitorDraft(current), renotifyMinutes: undefined };
    expect(checkUpdate(current, draft)).toEqual({
      body: {
        condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
        expectedVersion: 4,
        name: "Checkout failing",
        notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
        renotifyMinutes: null,
      },
      ok: true,
    });
  });
});

describe("monitor state", () => {
  test("muted until a past time reads as its evaluation state again", () => {
    expect(monitorState(monitor({ state: "firing" }), NOW)).toBe("firing");
    expect(monitorState(monitor({ status: "muted" }), NOW)).toBe("muted");
    expect(
      monitorState(monitor({ mutedUntil: "2026-11-03T09:00:00.000Z", status: "muted" }), NOW),
    ).toBe("ok");
    expect(monitorState(monitor({ state: "firing", status: "archived" }), NOW)).toBe("archived");
  });

  test("archived monitors offer no actions and muted ones offer unmute", () => {
    expect(monitorActions(monitor(), NOW)).toEqual(["edit", "mute", "test", "archive"]);
    expect(monitorActions(monitor({ status: "muted" }), NOW)).toEqual([
      "edit",
      "unmute",
      "test",
      "archive",
    ]);
    expect(monitorActions(monitor({ status: "archived" }), NOW)).toEqual([]);
  });
});
