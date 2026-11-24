import { createServerFn } from "@tanstack/react-start";
import type { CreateMonitorBody, UpdateMonitorBody } from "../alerts/monitor-model.ts";
import {
  archiveMonitor,
  createMonitor,
  putAlertPreferences,
  testMonitor,
  updateMonitor,
} from "../server/alert-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  keyedInputAt,
  requireBody,
  requireIds,
  type KeyedInputAt,
  type ScopeAt,
} from "./server-input.ts";

interface KeyedMonitorInput extends KeyedInputAt<"organization"> {
  readonly monitorId: string;
}

export const createMonitorFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization"> & { readonly body: CreateMonitorBody }) => ({
    ...keyedInputAt("organization", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createMonitor({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const updateMonitorFn = createServerFn({ method: "POST" })
  .validator((input: KeyedMonitorInput & { readonly body: UpdateMonitorBody }) => ({
    ...keyedInputAt("organization", input, ["monitorId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    updateMonitor({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const archiveMonitorFn = createServerFn({ method: "POST" })
  .validator((input: KeyedMonitorInput) => keyedInputAt("organization", input, ["monitorId"]))
  .handler(async ({ data }) =>
    archiveMonitor({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const testMonitorFn = createServerFn({ method: "POST" })
  .validator((input: KeyedMonitorInput) => keyedInputAt("organization", input, ["monitorId"]))
  .handler(async ({ data }) =>
    testMonitor({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

/** A member's own settings: replacing them twice with the same body is the same result. */
export const putAlertPreferencesFn = createServerFn({ method: "POST" })
  .validator((input: ScopeAt<"organization"> & { readonly body: unknown }) => ({
    ...requireIds(input, ["organizationId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    putAlertPreferences({
      accessToken: await requireAccessToken(),
      body: data.body,
      organizationId: data.organizationId,
    }),
  );
