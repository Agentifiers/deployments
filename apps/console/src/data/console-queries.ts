import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  loadEnvironment,
  loadOrganizationShell,
  loadOrganizations,
  loadPlatformAdministrator,
  loadSessionIdentity,
  loadSystemInstallation,
  loadSystemOrganizationPage,
} from "../server/console-data.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requireAccessToken } from "../server/session.ts";
import { pageInputAt, requireIds, type PageInputAt } from "./server-input.ts";

const fetchOrganizations = createServerFn({ method: "GET" }).handler(async () =>
  loadOrganizations(await requireAccessToken()),
);

const fetchOrganizationShell = createServerFn({ method: "GET" })
  .validator((input: { readonly organizationId: string }) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    loadOrganizationShell(await requireAccessToken(), data.organizationId),
  );

const fetchEnvironment = createServerFn({ method: "GET" })
  .validator(
    (input: EnvironmentScope): EnvironmentScope =>
      requireIds(input, ["environmentId", "organizationId", "projectId"]),
  )
  .handler(async ({ data }) => loadEnvironment(await requireAccessToken(), data));

const fetchSystemInstallation = createServerFn({ method: "GET" }).handler(async () =>
  loadSystemInstallation(await requireAccessToken()),
);

const fetchSessionIdentity = createServerFn({ method: "GET" }).handler(async () =>
  loadSessionIdentity(await requireAccessToken()),
);

const fetchPlatformAdministrator = createServerFn({ method: "GET" }).handler(async () =>
  loadPlatformAdministrator(await requireAccessToken()),
);

const fetchSystemOrganizationPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"none">) => pageInputAt("none", input))
  .handler(async ({ data }) => loadSystemOrganizationPage(await requireAccessToken(), data.cursor));

export const organizationsQuery = () =>
  queryOptions({ queryFn: () => fetchOrganizations(), queryKey: ["organizations"] });

export const organizationShellQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchOrganizationShell({ data: { organizationId } }),
    queryKey: ["organization-shell", organizationId],
  });

export const environmentQuery = (context: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchEnvironment({ data: context }),
    queryKey: ["environment", context.organizationId, context.projectId, context.environmentId],
  });

export const systemInstallationQuery = () =>
  queryOptions({ queryFn: () => fetchSystemInstallation(), queryKey: ["system-installation"] });

export const sessionIdentityQuery = () =>
  queryOptions({ queryFn: () => fetchSessionIdentity(), queryKey: ["session-identity"] });

/** Whether the caller is a platform administrator; `/` shows the System link only then. */
export const platformAdministratorQuery = () =>
  queryOptions({
    queryFn: () => fetchPlatformAdministrator(),
    queryKey: ["platform-administrator"],
  });

export const systemOrganizationsQuery = () =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchSystemOrganizationPage({
        data: { scope: {}, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["system-organizations"],
  });

/** Membership changed: the organization list and every shell's organization switcher. */
export function invalidateTenancy(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["organizations"] }),
    queryClient.invalidateQueries({ queryKey: ["organization-shell"] }),
  ]);
}
