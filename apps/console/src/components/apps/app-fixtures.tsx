import { mock } from "bun:test";
import { AppDomainResponse, AppResponse } from "@deployments-ai/api-contract";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import {
  environmentManager,
  focusManager,
  isServer,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Schema } from "effect";
import { act, type ReactNode } from "react";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { operationAccess } from "../../access.ts";
import { appWrites } from "../../apps/app-state.ts";
import * as mutations from "../../data/app-mutations.ts";
import { appDomainsQuery, appQuery } from "../../data/app-queries.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";

type Answer = (data: Readonly<Record<string, unknown>>) => Promise<unknown>;
type Stubbed = "attachAppDomain" | "detachAppDomain" | "refreshAppDomain" | "setAppPublication";

export const sent: { readonly data: Readonly<Record<string, unknown>>; readonly fn: Stubbed }[] =
  [];
export const answers: Record<Stubbed, Answer> = {
  attachAppDomain: () => Promise.reject(new Error("unset")),
  detachAppDomain: () => Promise.reject(new Error("unset")),
  refreshAppDomain: () => Promise.reject(new Error("unset")),
  setAppPublication: () => Promise.reject(new Error("unset")),
};
const recorded =
  (fn: Stubbed) =>
  ({ data }: { readonly data: Readonly<Record<string, unknown>> }) => {
    sent.push({ data, fn });
    return answers[fn](data);
  };
// oxlint-disable-next-line no-restricted-properties -- no console test may reach the server, so the stubs may outlive the file
await mock.module(Bun.resolveSync("../../data/app-mutations.ts", import.meta.dir), () => ({
  ...mutations,
  attachAppDomainFn: recorded("attachAppDomain"),
  detachAppDomainFn: recorded("detachAppDomain"),
  refreshAppDomainFn: recorded("refreshAppDomain"),
  setAppPublicationFn: recorded("setAppPublication"),
}));

export const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
export const APP = "01K000000000000000000000AP";
export const AT = "2026-10-09T12:00:00.000Z";
export const TOKEN = "deployments-app=0123456789abcdef0123456789abcdef";

const decodeApp = Schema.decodeUnknownSync(AppResponse);
const decodeDomain = Schema.decodeUnknownSync(AppDomainResponse);

export function app(
  publication: unknown,
  lifecycle: unknown = { liveReleaseId: null, state: "active" },
) {
  return decodeApp({
    access: { organizationMembers: "viewer" },
    agentDefinitionId: "01K000000000000000000000AD",
    createdAt: AT,
    createdBy: { principalId: null, runId: "01K000000000000000000000RN" },
    environmentId: scope.environmentId,
    id: APP,
    lifecycle,
    name: "Sign-up form",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    publication,
    slug: "sign-up",
    updatedAt: AT,
    url: "https://sign-up.apps.example.test",
    workspaceId: "01K000000000000000000000WS",
  });
}

export function domain(id: string, hostname: string, state: unknown) {
  return decodeDomain({
    appId: APP,
    attachedBy: { id: "01K000000000000000000000A1", principal: "human" },
    createdAt: AT,
    dnsRecords: [
      { name: `_deployments-app.${hostname}`, type: "TXT", value: TOKEN },
      {
        name: hostname,
        note: "A zone apex cannot hold a CNAME; publish an ALIAS or ANAME record, or use CNAME flattening.",
        type: "CNAME",
        value: "routing.apps.example.test",
      },
    ],
    hostname,
    id,
    state,
    updatedAt: AT,
  });
}

export const unverified = domain("01K000000000000000000000D1", "www.example.com", {
  kind: "unverified",
});
export const verified = domain("01K000000000000000000000D2", "events.example.com", {
  kind: "verified",
  problem: {
    code: "certificate_failed",
    message: "The certificate authority could not validate the hostname.",
    observedAt: AT,
  },
  verifiedAt: AT,
});
export const active = domain("01K000000000000000000000D3", "example.com", {
  activatedAt: AT,
  kind: "active",
  problem: null,
  verifiedAt: AT,
});

export const accessOf = (role: "admin" | "member") =>
  operationAccess({
    capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
    organizationRole: role,
  });

export const writesOf = (role: "admin" | "member", state: "active" | "archived" = "active") =>
  appWrites(state, accessOf(role));

export function client({
  app: shown,
  domains,
  environment = "development",
}: Readonly<{
  app?: AppResponse;
  domains: readonly AppDomainResponse[];
  environment?: EnvironmentSummary["type"];
}>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(appDomainsQuery(scope, APP).queryKey, [...domains]);
  if (shown) queryClient.setQueryData(appQuery(scope, APP).queryKey, shown);
  queryClient.setQueryData(
    ["environment", scope.organizationId, scope.projectId, scope.environmentId],
    { type: environment },
  );
  return queryClient;
}

export async function renderWith(
  queryClient: QueryClient,
  ui: ReactNode,
  run: (view: ClientView) => Promise<void>,
) {
  sent.length = 0;
  await withClient(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    async (view) => {
      const window = view.document.defaultView;
      if (!window) throw new Error("withClient installs a window");
      // Base UI radios click with PointerEvent, which jsdom lacks. react-dom loaded before this
      // DOM existed watches a focused text field through the old-browser attachEvent hooks.
      Object.assign(window, { PointerEvent: window.MouseEvent });
      Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
      await run(view);
    },
  );
}

export const render = (
  ui: ReactNode,
  domains: readonly AppDomainResponse[],
  run: (view: ClientView) => Promise<void>,
) => renderWith(client({ domains }), ui, run);

export const buttons = (view: ClientView, text: string) =>
  [...view.document.querySelectorAll("button")].filter((node) => node.textContent?.trim() === text);

export const rows = (view: ClientView) =>
  [...view.document.querySelectorAll("tbody tr")].map((row) => ({
    hostname: row.querySelector("td")?.textContent,
    state: row.querySelector("[data-slot=badge]")?.textContent,
    text: row.querySelectorAll("td")[1]?.textContent,
  }));

/**
 * Types into a controlled input. The attachEvent stub above leaves react-dom's change tracking
 * deaf to DOM input events, so this sets the value and calls the element's React onChange.
 */
export async function typeInto(view: ClientView, name: string, text: string) {
  const input = view.document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  const props = input
    ? Object.entries(input).find(([key]) => key.startsWith("__reactProps$"))?.[1]
    : undefined;
  if (!input || typeof props !== "object" || props === null || !("onChange" in props)) {
    throw new Error(`no controlled input named ${name}`);
  }
  const { onChange } = props;
  if (typeof onChange !== "function") throw new Error(`${name} has no onChange`);
  await act(async () => {
    input.value = text;
    onChange({ currentTarget: input, target: input });
  });
}

export interface PollingTimer {
  readonly delay: number;
  readonly tick: () => void;
}

/**
 * Runs `run` in a focused browser for TanStack Query, recording the refetch intervals it keeps.
 * Query reads the global `setInterval` on each call, so the recorder sees every poll it arms.
 */
export async function withPolling(run: (polling: () => PollingTimer[]) => Promise<void>) {
  const { clearInterval: realClear, setInterval: realSet } = globalThis;
  const armed = new Map<ReturnType<typeof realSet>, PollingTimer>();
  Object.assign(globalThis, {
    clearInterval: (id: ReturnType<typeof realSet> | undefined) => {
      if (id !== undefined) armed.delete(id);
      realClear(id);
    },
    setInterval: (tick: () => void, delay: number) => {
      const id = realSet(tick, delay);
      armed.set(id, { delay, tick });
      return id;
    },
  });
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
  try {
    await run(() => [...armed.values()]);
  } finally {
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => isServer);
    Object.assign(globalThis, { clearInterval: realClear, setInterval: realSet });
  }
}
