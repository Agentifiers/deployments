import "@tanstack/react-start/server-only";
import { automationListing, type AutomationListing } from "../automations/automation-listing.ts";
import {
  AUTOMATION_KINDS,
  automationRecord,
  automationRow,
  fireRow,
  type AutomationEntry,
  type AutomationKind,
  type AutomationRow,
  type FireRow,
  type LastFire,
} from "../automations/automation-state.ts";
import { PlatformApiError, type PlatformProblem } from "../errors.ts";
import type { RunStatus } from "../runs/run-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT, fillPage, type Page } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

const FIRE_PAGE_SIZE = 25;

export interface AutomationRef {
  readonly id: string;
  readonly kind: AutomationKind;
}

/** The raw record for kind-specific fields, plus its normalized row. */
export interface AutomationDetail {
  readonly entry: AutomationEntry;
  readonly row: AutomationRow;
}

export type FireRun =
  | { readonly kind: "loaded"; readonly status: RunStatus }
  | { readonly kind: "unavailable" };

export interface FireView {
  readonly fire: FireRow;
  readonly run?: FireRun;
}

interface FireListRequest {
  readonly accessToken: string;
  readonly cursor: string | undefined;
  readonly id: string;
  readonly limit: number;
  readonly scope: EnvironmentScope;
}

const FIRE_LISTS: Readonly<
  Record<AutomationKind, (request: FireListRequest) => Promise<Page<FireRow>>>
> = {
  heartbeat: async ({ accessToken, cursor, id, limit, scope }) => {
    const page = await callRoute(
      "listHeartbeatFires",
      { path: { heartbeatId: id }, query: { cursor, limit }, scope },
      accessToken,
    );
    return {
      items: page.fires.map((fire) => fireRow("heartbeat", fire)),
      nextCursor: page.nextCursor,
    };
  },
  schedule: async ({ accessToken, cursor, id, limit, scope }) => {
    const page = await callRoute(
      "listScheduleFires",
      { path: { scheduleId: id }, query: { cursor, limit }, scope },
      accessToken,
    );
    return {
      items: page.fires.map((fire) => fireRow("schedule", fire)),
      nextCursor: page.nextCursor,
    };
  },
};

const ENTRY_LOADERS: Readonly<
  Record<
    AutomationKind,
    (accessToken: string, scope: EnvironmentScope, id: string) => Promise<AutomationEntry>
  >
> = {
  heartbeat: async (accessToken, scope, heartbeatId) => ({
    heartbeat: await callRoute("getHeartbeat", { path: { heartbeatId }, scope }, accessToken),
    kind: "heartbeat",
  }),
  schedule: async (accessToken, scope, scheduleId) => ({
    kind: "schedule",
    schedule: await callRoute("getSchedule", { path: { scheduleId }, scope }, accessToken),
  }),
};

type ProblemCopy = Readonly<Partial<Record<number, Pick<PlatformProblem, "detail" | "title">>>>;

const LIST_PROBLEMS: ProblemCopy = {
  403: {
    detail: "Reading automations needs the schedules:read scope.",
    title: "Automations are not available to you",
  },
};

function itemProblems(kind: AutomationKind): ProblemCopy {
  const { label } = AUTOMATION_KINDS[kind];
  return {
    ...LIST_PROBLEMS,
    404: {
      detail: `This ${label.toLowerCase()} is not in this environment.`,
      title: `${label} not found`,
    },
  };
}

/** Replaces the API's wording for the statuses the automation screens explain themselves. */
async function explained<Result>(request: Promise<Result>, problems: ProblemCopy) {
  try {
    return await request;
  } catch (error) {
    if (!(error instanceof PlatformApiError)) throw error;
    const copy = problems[error.problem.status];
    throw copy ? new PlatformApiError(error.operation, { ...error.problem, ...copy }) : error;
  }
}

/**
 * Every automation in the environment. The list API returns rows grouped by status with active
 * last, so all pages are read before any ordering or paging.
 */
export async function loadAutomationListing(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<AutomationListing> {
  const [schedules, heartbeats] = await explained(
    Promise.all([
      collectPages(async (cursor) => {
        const page = await callRoute(
          "listSchedules",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        );
        return { items: page.schedules, nextCursor: page.nextCursor };
      }),
      collectPages(async (cursor) => {
        const page = await callRoute(
          "listHeartbeats",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        );
        return { items: page.heartbeats, nextCursor: page.nextCursor };
      }),
    ]),
    LIST_PROBLEMS,
  );
  return automationListing(
    [
      ...schedules.map((schedule): AutomationEntry => ({ kind: "schedule", schedule })),
      ...heartbeats.map((heartbeat): AutomationEntry => ({ heartbeat, kind: "heartbeat" })),
    ],
    new Date(),
  );
}

async function newestFire(accessToken: string, scope: EnvironmentScope, ref: AutomationRef) {
  const page = await FIRE_LISTS[ref.kind]({
    accessToken,
    cursor: undefined,
    id: ref.id,
    limit: 1,
    scope,
  });
  return page.items[0];
}

/** The newest fire of each ref, by ID. A failed read leaves only that automation `unavailable`. */
export async function loadLastFires(
  accessToken: string,
  scope: EnvironmentScope,
  refs: readonly AutomationRef[],
): Promise<Readonly<Record<string, LastFire>>> {
  const fires = await fanOut(refs, async (ref): Promise<readonly [string, LastFire]> => {
    try {
      const fire = await newestFire(accessToken, scope, ref);
      return [ref.id, fire ? { fire, kind: "fired" } : { kind: "never" }];
    } catch (error) {
      if (error instanceof PlatformApiError) return [ref.id, { kind: "unavailable" }];
      throw error;
    }
  });
  return Object.fromEntries(fires);
}

export async function loadAutomation(
  accessToken: string,
  scope: EnvironmentScope,
  ref: AutomationRef,
): Promise<AutomationDetail> {
  const [entry, fire] = await explained(
    Promise.all([
      ENTRY_LOADERS[ref.kind](accessToken, scope, ref.id),
      newestFire(accessToken, scope, ref),
    ]),
    itemProblems(ref.kind),
  );
  return {
    entry,
    row: automationRow(
      automationRecord(entry),
      fire ? { fire, kind: "fired" } : { kind: "never" },
      new Date(),
    ),
  };
}

async function fireRun(
  accessToken: string,
  scope: EnvironmentScope,
  runId: string,
): Promise<FireRun> {
  try {
    const run = await callRoute("getRunById", { path: { runId }, scope }, accessToken);
    return { kind: "loaded", status: run.status };
  } catch (error) {
    if (error instanceof PlatformApiError) return { kind: "unavailable" };
    throw error;
  }
}

export async function loadFirePage(
  accessToken: string,
  scope: EnvironmentScope,
  ref: AutomationRef,
  cursor: string | undefined,
): Promise<Page<FireView>> {
  const page = await explained(
    fillPage(
      (pageCursor, limit) =>
        FIRE_LISTS[ref.kind]({ accessToken, cursor: pageCursor, id: ref.id, limit, scope }),
      cursor,
      FIRE_PAGE_SIZE,
    ),
    itemProblems(ref.kind),
  );
  const items = await fanOut(page.items, async (fire) =>
    fire.runId === undefined
      ? { fire }
      : { fire, run: await fireRun(accessToken, scope, fire.runId) },
  );
  return { ...page, items };
}
