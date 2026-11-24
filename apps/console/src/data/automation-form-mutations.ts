import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type {
  HeartbeatChanges,
  HeartbeatCreateBody,
  ScheduleChanges,
  ScheduleCreateBody,
} from "../automations/automation-form.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  createHeartbeat,
  createSchedule,
  loadAutomationTargets,
  updateHeartbeat,
  updateSchedule,
} from "../server/automation-form-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { automationsKey } from "./automation-queries.ts";
import {
  fields,
  keyedInput,
  requireBody,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

/** The action decodes the body against its contract schema. */
interface CreateInput<Body> extends KeyedInput {
  readonly body: Body;
  readonly startPaused: boolean;
}

interface UpdateInput<Body> extends ScopedInput {
  readonly body: Body;
  readonly expectedVersion: number;
  readonly id: string;
}

function createInput(input: unknown) {
  const { startPaused } = fields(input);
  if (typeof startPaused !== "boolean") throw new TypeError("startPaused must be a boolean.");
  return { ...keyedInput(input), body: requireBody(input), startPaused };
}

function updateInput(input: unknown) {
  const { expectedVersion } = fields(input);
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw new TypeError("expectedVersion must be a non-negative integer.");
  }
  return { ...scopedInput(input, ["id"]), body: requireBody(input), expectedVersion };
}

export const createScheduleFn = createServerFn({ method: "POST" })
  .validator((input: CreateInput<ScheduleCreateBody>) => createInput(input))
  .handler(async ({ data }) =>
    createSchedule({ ...data, accessToken: await requireAccessToken() }),
  );

export const createHeartbeatFn = createServerFn({ method: "POST" })
  .validator((input: CreateInput<HeartbeatCreateBody>) => createInput(input))
  .handler(async ({ data }) =>
    createHeartbeat({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateScheduleFn = createServerFn({ method: "POST" })
  .validator((input: UpdateInput<ScheduleChanges>) => updateInput(input))
  .handler(async ({ data }) =>
    updateSchedule({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateHeartbeatFn = createServerFn({ method: "POST" })
  .validator((input: UpdateInput<HeartbeatChanges>) => updateInput(input))
  .handler(async ({ data }) =>
    updateHeartbeat({ ...data, accessToken: await requireAccessToken() }),
  );

const fetchAutomationTargets = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadAutomationTargets(await requireAccessToken(), data.scope));

export const automationTargetsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchAutomationTargets({ data: { scope } }),
    queryKey: [...automationsKey(scope), "targets", ...scopeKey(scope)],
  });
