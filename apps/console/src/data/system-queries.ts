import { SPEND_MONTH_PATTERN_SOURCE } from "@deployments-ai/api-contract/system";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  findSystemPerson,
  loadSystemAlarms,
  loadSystemComponents,
  loadSystemDeploymentPage,
  loadSystemModelProviders,
  loadSystemOperatorAccessPage,
  loadSystemOrganization,
  loadSystemOrganizationSpend,
  loadSystemOrganizationStanding,
  loadSystemPerson,
  loadSystemSecurityEventPage,
  loadSystemStandingHistoryPage,
} from "../server/system-data.ts";
import { fields, pageInputAt, requireIds, type PageInputAt } from "./server-input.ts";

const MONTH = new RegExp(SPEND_MONTH_PATTERN_SOURCE, "u");

type OrganizationInput = { readonly organizationId: string };
const organizationInput = (input: OrganizationInput) => requireIds(input, ["organizationId"]);

const fetchDeploymentPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"none">) => pageInputAt("none", input))
  .handler(async ({ data }) => loadSystemDeploymentPage(await requireAccessToken(), data.cursor));

const fetchComponents = createServerFn({ method: "GET" }).handler(async () =>
  loadSystemComponents(await requireAccessToken()),
);

const fetchAlarms = createServerFn({ method: "GET" }).handler(async () =>
  loadSystemAlarms(await requireAccessToken()),
);

const fetchModelProviders = createServerFn({ method: "GET" }).handler(async () =>
  loadSystemModelProviders(await requireAccessToken()),
);

const fetchOrganization = createServerFn({ method: "GET" })
  .validator(organizationInput)
  .handler(async ({ data }) =>
    loadSystemOrganization(await requireAccessToken(), data.organizationId),
  );

const fetchStanding = createServerFn({ method: "GET" })
  .validator(organizationInput)
  .handler(async ({ data }) =>
    loadSystemOrganizationStanding(await requireAccessToken(), data.organizationId),
  );

const fetchStandingHistoryPage = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput & PageInputAt<"none">) => ({
    ...pageInputAt("none", input),
    ...organizationInput(input),
  }))
  .handler(async ({ data }) =>
    loadSystemStandingHistoryPage(await requireAccessToken(), data.organizationId, data.cursor),
  );

const fetchSpend = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput & { readonly month: string }) => {
    const { month } = fields(input);
    if (typeof month !== "string" || !MONTH.test(month)) {
      throw new TypeError("month must be YYYY-MM.");
    }
    return { ...organizationInput(input), month };
  })
  .handler(async ({ data }) =>
    loadSystemOrganizationSpend(await requireAccessToken(), data.organizationId, data.month),
  );

const fetchOperatorAccessPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"none">) => pageInputAt("none", input))
  .handler(async ({ data }) =>
    loadSystemOperatorAccessPage(await requireAccessToken(), data.cursor),
  );

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

export const systemDeploymentsQuery = () =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDeploymentPage({ data: { scope: {}, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["system", "deployments"],
  });

export const systemComponentsQuery = () =>
  queryOptions({ queryFn: () => fetchComponents(), queryKey: ["system", "components"] });

export const systemAlarmsQuery = () =>
  queryOptions({ queryFn: () => fetchAlarms(), queryKey: ["system", "alarms"] });

export const systemModelProvidersQuery = () =>
  queryOptions({ queryFn: () => fetchModelProviders(), queryKey: ["system", "model-providers"] });

export const systemOrganizationQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchOrganization({ data: { organizationId } }),
    queryKey: ["system", "organization", organizationId],
  });

export const systemStandingQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchStanding({ data: { organizationId } }),
    queryKey: ["system", "standing", organizationId],
  });

export const systemStandingHistoryQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchStandingHistoryPage({
        data: { organizationId, scope: {}, ...cursorField(pageParam) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["system", "standing", organizationId, "history"],
  });

export const systemSpendQuery = (organizationId: string, month: string) =>
  queryOptions({
    queryFn: () => fetchSpend({ data: { month, organizationId } }),
    queryKey: ["system", "spend", organizationId, month],
  });

/** A standing change also changes the history; the members' own standing banner reads it too. */
export function invalidateStanding(queryClient: QueryClient, organizationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["system", "standing", organizationId] }),
    queryClient.invalidateQueries({ queryKey: ["organization-standing", organizationId] }),
  ]);
}

export const systemOperatorAccessQuery = () =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchOperatorAccessPage({ data: { scope: {}, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["system", "operator-access"],
  });

/**
 * Opening or closing access changes what the organization's own routes return to this caller,
 * so its cached member directory goes too.
 */
export function invalidateOperatorAccess(queryClient: QueryClient, organizationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["system", "organization", organizationId] }),
    queryClient.invalidateQueries({ queryKey: ["system", "operator-access"] }),
    queryClient.invalidateQueries({ queryKey: ["members", organizationId] }),
  ]);
}

type PersonInput = { readonly principalId: string };
const personInput = (input: PersonInput) => requireIds(input, ["principalId"]);

const fetchPersonByEmail = createServerFn({ method: "GET" })
  .validator((input: { readonly email: string }) => {
    const { email } = fields(input);
    if (typeof email !== "string" || email.trim() === "" || email.length > 320) {
      throw new TypeError("email must be 1 to 320 characters.");
    }
    return { email: email.trim() };
  })
  .handler(async ({ data }) => findSystemPerson(await requireAccessToken(), data.email));

const fetchPerson = createServerFn({ method: "GET" })
  .validator(personInput)
  .handler(async ({ data }) => loadSystemPerson(await requireAccessToken(), data.principalId));

const fetchSecurityEventPage = createServerFn({ method: "GET" })
  .validator((input: PersonInput & PageInputAt<"none">) => ({
    ...pageInputAt("none", input),
    ...personInput(input),
  }))
  .handler(async ({ data }) =>
    loadSystemSecurityEventPage(await requireAccessToken(), data.principalId, data.cursor),
  );

export const systemPersonByEmailQuery = (email: string) =>
  queryOptions({
    queryFn: () => fetchPersonByEmail({ data: { email } }),
    queryKey: ["system", "person-by-email", email],
  });

export const systemPersonQuery = (principalId: string) =>
  queryOptions({
    queryFn: () => fetchPerson({ data: { principalId } }),
    queryKey: ["system", "person", principalId],
  });

export const systemSecurityEventsQuery = (principalId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchSecurityEventPage({ data: { principalId, scope: {}, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["system", "person", principalId, "security-events"],
  });

/** Every person action changes the person's detail, status, or security events. */
export function invalidatePerson(queryClient: QueryClient, principalId: string) {
  return queryClient.invalidateQueries({ queryKey: ["system", "person", principalId] });
}
