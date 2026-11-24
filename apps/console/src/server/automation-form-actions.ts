import "@tanstack/react-start/server-only";
import { heartbeatValues, scheduleValues } from "../automations/automation-form.ts";
import type { AutomationEntry, AutomationKind } from "../automations/automation-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import { needsWrite } from "./expected-version.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface Mutation {
  readonly accessToken: string;
  readonly scope: EnvironmentScope;
}

/**
 * What a create form offers: deployments that can start runs, and active workspaces. `kinds` are
 * the automation kinds the deployment's pinned release allows.
 */
export interface AutomationTargets {
  readonly deployments: readonly {
    readonly definitionId: string;
    readonly id: string;
    readonly kinds: readonly AutomationKind[];
  }[];
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}

const AUTOMATION_KINDS: readonly AutomationKind[] = ["heartbeat", "schedule"];

export async function loadAutomationTargets(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<AutomationTargets> {
  const [deployments, workspaces] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listAgentDeployments",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    collectPages((cursor) =>
      callRoute("listWorkspaces", { query: { cursor, limit: API_PAGE_LIMIT }, scope }, accessToken),
    ),
  ]);
  // The automation service refuses a deployment that is not ready and running.
  const runnable = deployments.filter(
    (deployment) => deployment.currentState === "ready" && deployment.desiredState === "running",
  );
  const kinds = await releaseKinds(
    accessToken,
    scope,
    runnable.map((deployment) => deployment.agentReleaseId),
  );
  return {
    deployments: runnable.map((deployment) => ({
      definitionId: deployment.agentDefinitionId,
      id: deployment.id,
      kinds: kinds.get(deployment.agentReleaseId) ?? AUTOMATION_KINDS,
    })),
    workspaces: workspaces
      .filter((workspace) => workspace.status === "active")
      .map(({ id, name }) => ({ id, name })),
  };
}

/**
 * The automation kinds each release's manifest allows; a manifest without `triggers` allows all.
 * A missing release allows none, since the API refuses its deployment. A release that cannot be
 * read for another reason is left out, so its deployment stays offered and the API decides.
 */
async function releaseKinds(
  accessToken: string,
  scope: EnvironmentScope,
  releaseIds: readonly string[],
): Promise<Map<string, readonly AutomationKind[]>> {
  const entries = await fanOut(
    [...new Set(releaseIds)],
    async (id): Promise<readonly [string, readonly AutomationKind[]] | undefined> => {
      try {
        const release = await callRoute("getAgentRelease", { path: { id }, scope }, accessToken);
        const allowed = release.manifest.spec.triggers;
        return [
          id,
          AUTOMATION_KINDS.filter((kind) => allowed === undefined || allowed.includes(kind)),
        ];
      } catch (error) {
        if (error instanceof UnauthenticatedError) throw error;
        if (error instanceof PlatformApiError && error.problem.status === 404) return [id, []];
        return undefined;
      }
    },
  );
  return new Map(entries.filter((entry) => entry !== undefined));
}

/**
 * Creates a schedule. `startPaused` pauses it right after: the API has no create-paused field,
 * so a far-off first fire is the only guard against the short window before the pause lands.
 */
export async function createSchedule({
  accessToken,
  body,
  idempotencyKey,
  scope,
  startPaused,
}: Mutation & {
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly startPaused: boolean;
}): Promise<AutomationEntry> {
  const schedule = await callRoute(
    "createSchedule",
    {
      body: decodeRequestBody("createSchedule", "CreateScheduleRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  if (!startPaused || schedule.status === "paused" || schedule.status === "archived") {
    return { kind: "schedule", schedule };
  }
  const paused = await callRoute(
    "pauseSchedule",
    { path: { scheduleId: schedule.id }, scope },
    accessToken,
  );
  return { kind: "schedule", schedule: paused };
}

export async function createHeartbeat({
  accessToken,
  body,
  idempotencyKey,
  scope,
  startPaused,
}: Mutation & {
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly startPaused: boolean;
}): Promise<AutomationEntry> {
  const heartbeat = await callRoute(
    "createHeartbeat",
    {
      body: decodeRequestBody("createHeartbeat", "CreateHeartbeatRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  if (!startPaused || heartbeat.status === "paused" || heartbeat.status === "archived") {
    return { heartbeat, kind: "heartbeat" };
  }
  const paused = await callRoute(
    "pauseHeartbeat",
    { path: { heartbeatId: heartbeat.id }, scope },
    accessToken,
  );
  return { heartbeat: paused, kind: "heartbeat" };
}

/**
 * Updates a schedule the form read at `expectedVersion`. The route takes no version and no
 * idempotency key, so a re-read decides: already applied returns it, moved on refuses.
 */
export async function updateSchedule({
  accessToken,
  body,
  expectedVersion,
  id,
  scope,
}: Mutation & {
  readonly body: unknown;
  readonly expectedVersion: number;
  readonly id: string;
}): Promise<AutomationEntry> {
  const changes = decodeRequestBody("updateSchedule", "UpdateScheduleRequest", body);
  const current = await callRoute("getSchedule", { path: { scheduleId: id }, scope }, accessToken);
  const write = needsWrite(
    "updateSchedule",
    "schedule",
    { values: scheduleValues(current), version: current.version },
    changes,
    expectedVersion,
  );
  if (!write) return { kind: "schedule", schedule: current };
  const schedule = await callRoute(
    "updateSchedule",
    {
      body: changes,
      path: { scheduleId: id },
      scope,
    },
    accessToken,
  );
  return { kind: "schedule", schedule };
}

export async function updateHeartbeat({
  accessToken,
  body,
  expectedVersion,
  id,
  scope,
}: Mutation & {
  readonly body: unknown;
  readonly expectedVersion: number;
  readonly id: string;
}): Promise<AutomationEntry> {
  const changes = decodeRequestBody("updateHeartbeat", "UpdateHeartbeatRequest", body);
  const current = await callRoute(
    "getHeartbeat",
    { path: { heartbeatId: id }, scope },
    accessToken,
  );
  const write = needsWrite(
    "updateHeartbeat",
    "heartbeat",
    { values: heartbeatValues(current), version: current.version },
    changes,
    expectedVersion,
  );
  if (!write) return { heartbeat: current, kind: "heartbeat" };
  const heartbeat = await callRoute(
    "updateHeartbeat",
    {
      body: changes,
      path: { heartbeatId: id },
      scope,
    },
    accessToken,
  );
  return { heartbeat, kind: "heartbeat" };
}
