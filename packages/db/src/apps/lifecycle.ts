import type { AppLifecycle, AppLifecycleState, AppRecord } from "../records/apps.ts";
import { refuse } from "./errors.ts";

export type AppLifecycleTarget = AppLifecycleState | "erased";

export type AppTransition =
  | { readonly to: "active" }
  | { readonly to: "archived" }
  | { readonly to: "erasing" }
  | { readonly reason: string; readonly to: "failed" }
  | { readonly to: "provisioning" };

const APP_LIFECYCLE_TRANSITIONS: {
  readonly [From in AppLifecycleState]: readonly AppLifecycleTarget[];
} = {
  provisioning: ["provisioning", "active", "failed", "erasing"],
  failed: ["erasing"],
  active: ["archived", "erasing"],
  archived: ["erasing"],
  erasing: ["erased"],
};

export const PROVISION_INVOCATION_ATTEMPTS = 1;
export const PROVISION_SETTLE_MILLISECONDS = 10 * 60_000;

export const APP_TRANSITION_EVENT_TYPES = {
  active: "app.activated",
  archived: "app.archived",
  erased: "app.erased",
  erasing: "app.erasing",
  failed: "app.failed",
  provisioning: "app.provisioning.resumed",
} as const satisfies Record<AppLifecycleTarget, string>;

export type AppChange = "configure" | "release";

export const APP_CHANGE_STATES: {
  readonly [Change in AppChange]: readonly AppLifecycleState[];
} = {
  configure: ["provisioning", "active"],
  release: ["active"],
};

export function requireAppTransition(
  operation: string,
  app: AppRecord["data"],
  to: AppLifecycleTarget,
  now: Date,
) {
  const from = app.lifecycle.state;
  if (!APP_LIFECYCLE_TRANSITIONS[from].includes(to)) {
    refuse(operation, "illegal-state", `An app cannot move from ${from} to ${to}.`);
  }
  const provisionStartedAt =
    from === "provisioning" ? app.updatedAt : app.databaseConvergenceStartedAt;
  if (to !== "erasing" || provisionStartedAt === undefined) return;
  const erasableAfter = Date.parse(provisionStartedAt) + PROVISION_SETTLE_MILLISECONDS;
  if (now.getTime() <= erasableAfter) {
    refuse(
      operation,
      "still-provisioning",
      `App ${app.id} may still be provisioning; erasure becomes possible after ${new Date(erasableAfter).toISOString()}.`,
    );
  }
}

export function liveReleaseIdOf(lifecycle: AppLifecycle) {
  return lifecycle.state === "active" || lifecycle.state === "archived"
    ? lifecycle.liveReleaseId
    : null;
}

export function nextAppLifecycle(
  app: AppRecord["data"],
  transition: AppTransition,
  now: Date,
): AppLifecycle {
  requireAppTransition("transition", app, transition.to, now);
  const at = now.toISOString();
  switch (transition.to) {
    case "active":
      return { liveReleaseId: liveReleaseIdOf(app.lifecycle), state: "active" };
    case "archived":
      return { archivedAt: at, liveReleaseId: liveReleaseIdOf(app.lifecycle), state: "archived" };
    case "erasing":
      return { requestedAt: at, state: "erasing" };
    case "failed":
      return { failedAt: at, reason: transition.reason, state: "failed" };
    case "provisioning":
      return { requestedAt: at, state: "provisioning" };
  }
}
