import "@tanstack/react-start/server-only";
import { notFound } from "@tanstack/react-router";
import { PlatformApiError } from "../errors.ts";
import { notFoundUnlessSignedOut } from "./admission.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

const PAGE_LIMIT = 50;
const ALARM_PAGE_LIMIT = 100;

export type SystemDeployment = RouteResponse<"listSystemDeployments">["items"][number];
export type SystemComponents = RouteResponse<"getSystemComponents">;
export type SystemAlarm = RouteResponse<"listSystemAlarms">["items"][number];
export type SystemModelProvider = RouteResponse<"listSystemModelProviders">["items"][number];
export type SystemStanding = RouteResponse<"getSystemOrganizationStanding">;
export type SystemStandingChange =
  RouteResponse<"listSystemOrganizationStandingHistory">["items"][number];
export type SystemSpend = RouteResponse<"getSystemOrganizationSpend">;

export interface SystemPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

function page<Item>(response: {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}): SystemPage<Item> {
  return response.nextCursor === null
    ? { items: response.items }
    : { items: response.items, nextCursor: response.nextCursor };
}

export async function loadSystemDeploymentPage(
  accessToken: string,
  cursor: string | undefined,
): Promise<SystemPage<SystemDeployment>> {
  return page(
    await callRoute("listSystemDeployments", { query: { cursor, limit: PAGE_LIMIT } }, accessToken),
  );
}

export function loadSystemComponents(accessToken: string): Promise<SystemComponents> {
  return callRoute("getSystemComponents", {}, accessToken);
}

const ALARM_ORDER: Readonly<Record<SystemAlarm["state"], number>> = {
  ALARM: 0,
  INSUFFICIENT_DATA: 1,
  OK: 2,
};

/** Every alarm, firing ones first, so the page never hides an alarm on a later page. */
export async function loadSystemAlarms(accessToken: string): Promise<readonly SystemAlarm[]> {
  const alarms = await collectPages((cursor) =>
    callRoute("listSystemAlarms", { query: { cursor, limit: ALARM_PAGE_LIMIT } }, accessToken),
  );
  return alarms.toSorted(
    (left, right) =>
      ALARM_ORDER[left.state] - ALARM_ORDER[right.state] || left.name.localeCompare(right.name),
  );
}

export async function loadSystemModelProviders(
  accessToken: string,
): Promise<readonly SystemModelProvider[]> {
  return (await callRoute("listSystemModelProviders", {}, accessToken)).items;
}

export function loadSystemOrganizationStanding(
  accessToken: string,
  organizationId: string,
): Promise<SystemStanding> {
  return callRoute("getSystemOrganizationStanding", { path: { organizationId } }, accessToken);
}

export async function loadSystemStandingHistoryPage(
  accessToken: string,
  organizationId: string,
  cursor: string | undefined,
): Promise<SystemPage<SystemStandingChange>> {
  return page(
    await callRoute(
      "listSystemOrganizationStandingHistory",
      { path: { organizationId }, query: { cursor, limit: PAGE_LIMIT } },
      accessToken,
    ),
  );
}

export function loadSystemOrganizationSpend(
  accessToken: string,
  organizationId: string,
  month: string,
): Promise<SystemSpend> {
  return callRoute(
    "getSystemOrganizationSpend",
    { path: { organizationId }, query: { month } },
    accessToken,
  );
}

export type SystemOrganizationAccess = RouteResponse<"getSystemOrganizationAccess">;
export type SystemOperatorAccess = RouteResponse<"listSystemOperatorAccess">["items"][number];

/**
 * The organization and the caller's operator access to it, read through the system API so the
 * page renders before access is open; the organization's own routes refuse an administrator
 * without it.
 */
export async function loadSystemOrganization(
  accessToken: string,
  organizationId: string,
): Promise<SystemOrganizationAccess> {
  return callRoute("getSystemOrganizationAccess", { path: { organizationId } }, accessToken).catch(
    (error: unknown) => {
      if (error instanceof PlatformApiError && error.problem.status === 404) throw notFound();
      return notFoundUnlessSignedOut(error, () => callRoute("getIdentity", {}, accessToken));
    },
  );
}

export async function loadSystemOperatorAccessPage(
  accessToken: string,
  cursor: string | undefined,
): Promise<SystemPage<SystemOperatorAccess>> {
  return page(
    await callRoute(
      "listSystemOperatorAccess",
      { query: { cursor, limit: PAGE_LIMIT } },
      accessToken,
    ),
  );
}

export type SystemPersonMatch = RouteResponse<"findSystemPrincipal">;
export type SystemPerson = RouteResponse<"getSystemPrincipal">;
export type SystemSecurityEvent =
  RouteResponse<"listSystemPrincipalSecurityEvents">["items"][number];

/** The person or pending sign-up holding exactly this email, or null when nobody does. */
export function findSystemPerson(
  accessToken: string,
  email: string,
): Promise<SystemPersonMatch | null> {
  return callRoute("findSystemPrincipal", { query: { email } }, accessToken).catch(
    (error: unknown) => {
      if (error instanceof PlatformApiError && error.problem.status === 404) return null;
      throw error;
    },
  );
}

export function loadSystemPerson(accessToken: string, principalId: string): Promise<SystemPerson> {
  return callRoute("getSystemPrincipal", { path: { principalId } }, accessToken).catch(
    (error: unknown) => {
      if (error instanceof PlatformApiError && error.problem.status === 404) throw notFound();
      throw error;
    },
  );
}

export async function loadSystemSecurityEventPage(
  accessToken: string,
  principalId: string,
  cursor: string | undefined,
): Promise<SystemPage<SystemSecurityEvent>> {
  return page(
    await callRoute(
      "listSystemPrincipalSecurityEvents",
      { path: { principalId }, query: { cursor, limit: PAGE_LIMIT } },
      accessToken,
    ),
  );
}
