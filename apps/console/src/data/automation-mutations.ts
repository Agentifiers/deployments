import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import {
  changeAutomationStatus,
  fireAutomation,
  type StatusChange,
} from "../server/automation-actions.ts";
import type { AutomationRef } from "../server/automation-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { automationRefInput } from "./automation-queries.ts";
import {
  fields,
  keyedInput,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

const STATUS_CHANGES = ["archive", "pause", "resume"] as const satisfies readonly StatusChange[];

export const changeAutomationStatusFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & AutomationRef & { readonly change: StatusChange }) => {
    const change = oneOf(STATUS_CHANGES, fields(input).change);
    if (change === undefined) {
      throw new TypeError(`change must be one of ${STATUS_CHANGES.join(", ")}.`);
    }
    return { ...scopedInput(input), change, ref: automationRefInput(input) };
  })
  .handler(async ({ data }) =>
    changeAutomationStatus({ ...data, accessToken: await requireAccessToken() }),
  );

export const fireAutomationFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & AutomationRef & { readonly agentDeploymentId: string }) => ({
    ...keyedInput(input, ["agentDeploymentId"]),
    ref: automationRefInput(input),
  }))
  .handler(async ({ data }) =>
    fireAutomation({ ...data, accessToken: await requireAccessToken() }),
  );
