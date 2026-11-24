import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseInboxSearch, type InboxStatus } from "../email/inbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  loadBinding,
  loadBindingPage,
  loadDeploymentTargets,
  loadInbox,
  loadInboxPage,
} from "../server/agent-email-inbox-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { agentEmailKey } from "./agent-email-setup-queries.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const fetchInboxPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly status: InboxStatus | undefined }) => ({
    ...pageInput(input),
    status: parseInboxSearch(fields(input)).status,
  }))
  .handler(async ({ data }) =>
    loadInboxPage(await requireAccessToken(), data.scope, data.status, data.cursor),
  );

const fetchInbox = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly inboxId: string }) => scopedInput(input, ["inboxId"]))
  .handler(async ({ data }) => loadInbox(await requireAccessToken(), data.scope, data.inboxId));

const fetchBindingPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly inboxId: string }) => pageInput(input, ["inboxId"]))
  .handler(async ({ data }) =>
    loadBindingPage(await requireAccessToken(), data.scope, data.inboxId, data.cursor),
  );

const fetchBinding = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly bindingId: string }) =>
    scopedInput(input, ["bindingId"]),
  )
  .handler(async ({ data }) => loadBinding(await requireAccessToken(), data.scope, data.bindingId));

const fetchDeploymentTargets = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadDeploymentTargets(await requireAccessToken(), data.scope));

export const inboxPagesQuery = (scope: EnvironmentScope, status: InboxStatus | undefined) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchInboxPage({
        data: { scope, status, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...agentEmailKey(scope), "inboxes", status],
  });

export const inboxQuery = (scope: EnvironmentScope, inboxId: string) =>
  queryOptions({
    queryFn: () => fetchInbox({ data: { inboxId, scope } }),
    queryKey: [...agentEmailKey(scope), "inbox", inboxId],
  });

export const bindingPagesQuery = (scope: EnvironmentScope, inboxId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBindingPage({
        data: { inboxId, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...agentEmailKey(scope), "bindings", inboxId],
  });

export const bindingQuery = (scope: EnvironmentScope, bindingId: string) =>
  queryOptions({
    queryFn: () => fetchBinding({ data: { bindingId, scope } }),
    queryKey: [...agentEmailKey(scope), "binding", bindingId],
  });

export const deploymentTargetsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchDeploymentTargets({ data: { scope } }),
    queryKey: [...agentEmailKey(scope), "deployment-targets"],
  });
