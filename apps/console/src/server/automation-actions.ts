import "@tanstack/react-start/server-only";
import {
  fireRow,
  type AutomationAction,
  type AutomationEntry,
  type AutomationKind,
  type FireRow,
} from "../automations/automation-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import type { AutomationRef } from "./automation-data.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type StatusChange = Exclude<AutomationAction, "fire">;

type AutomationRun = NonNullable<RouteResponse<"fireSchedule">["run"]>;

/**
 * What a fire did: the run it started, or the recorded reason it started none. A replayed key
 * returns the original fire, which reads the same as a fresh one.
 */
export interface FireResult {
  readonly fire: FireRow;
  readonly run?: AutomationRun;
}

interface AutomationMutation {
  readonly accessToken: string;
  readonly ref: AutomationRef;
  readonly scope: EnvironmentScope;
}

type StatusRoute = (mutation: AutomationMutation) => Promise<AutomationEntry>;

const STATUS_ROUTES: Readonly<Record<AutomationKind, Readonly<Record<StatusChange, StatusRoute>>>> =
  {
    heartbeat: {
      archive: async ({ accessToken, ref, scope }) => ({
        heartbeat: await callRoute(
          "archiveHeartbeat",
          { path: { heartbeatId: ref.id }, scope },
          accessToken,
        ),
        kind: "heartbeat",
      }),
      pause: async ({ accessToken, ref, scope }) => ({
        heartbeat: await callRoute(
          "pauseHeartbeat",
          { path: { heartbeatId: ref.id }, scope },
          accessToken,
        ),
        kind: "heartbeat",
      }),
      resume: async ({ accessToken, ref, scope }) => ({
        heartbeat: await callRoute(
          "resumeHeartbeat",
          { path: { heartbeatId: ref.id }, scope },
          accessToken,
        ),
        kind: "heartbeat",
      }),
    },
    schedule: {
      archive: async ({ accessToken, ref, scope }) => ({
        kind: "schedule",
        schedule: await callRoute(
          "archiveSchedule",
          { path: { scheduleId: ref.id }, scope },
          accessToken,
        ),
      }),
      pause: async ({ accessToken, ref, scope }) => ({
        kind: "schedule",
        schedule: await callRoute(
          "pauseSchedule",
          { path: { scheduleId: ref.id }, scope },
          accessToken,
        ),
      }),
      resume: async ({ accessToken, ref, scope }) => ({
        kind: "schedule",
        schedule: await callRoute(
          "resumeSchedule",
          { path: { scheduleId: ref.id }, scope },
          accessToken,
        ),
      }),
    },
  };

export function changeAutomationStatus({
  change,
  ...mutation
}: AutomationMutation & { readonly change: StatusChange }): Promise<AutomationEntry> {
  return STATUS_ROUTES[mutation.ref.kind][change](mutation);
}

/** A heartbeat fire names its deployment in the body; a schedule fire sends none. */
export async function fireAutomation({
  accessToken,
  agentDeploymentId,
  idempotencyKey,
  ref,
  scope,
}: AutomationMutation & {
  readonly agentDeploymentId: string;
  readonly idempotencyKey: string;
}): Promise<FireResult> {
  if (ref.kind === "schedule") {
    const { fire, run } = await callRoute(
      "fireSchedule",
      { idempotencyKey, path: { scheduleId: ref.id }, scope },
      accessToken,
    );
    return { fire: fireRow("schedule", fire), ...(run ? { run } : {}) };
  }
  const { heartbeatRun, run } = await callRoute(
    "fireHeartbeat",
    {
      body: decodeRequestBody("fireHeartbeat", "FireHeartbeatRequest", { agentDeploymentId }),
      idempotencyKey,
      path: { heartbeatId: ref.id },
      scope,
    },
    accessToken,
  );
  return { fire: fireRow("heartbeat", heartbeatRun), ...(run ? { run } : {}) };
}
