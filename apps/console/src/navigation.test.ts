import { describe, expect, test } from "bun:test";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { Invoice01Icon } from "@hugeicons/core-free-icons";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { operationAccess } from "./access.ts";
import { DEFAULT_CONSOLE_EDITION, type ConsoleEdition } from "./edition.ts";
import {
  ENVIRONMENT_NAVIGATION,
  anyOf,
  environmentHref,
  isCurrent,
  organizationLinks,
  visibleSections,
  type NavSection,
} from "./navigation.ts";
import type { ConsoleAuthorization } from "./permissions.ts";

const scope = { environmentId: "env1", organizationId: "org1", projectId: "prj1" };
const base = "/o/org1/p/prj1/e/env1";

function outline(sections: readonly NavSection<string>[]) {
  return sections.map((section) => [section.heading, section.items.map((item) => item.label)]);
}

function environmentSidebar(authorization: ConsoleAuthorization) {
  return outline(visibleSections(ENVIRONMENT_NAVIGATION, operationAccess(authorization)));
}

function currentItems(pathname: string) {
  return ENVIRONMENT_NAVIGATION.flatMap((section) => section.items)
    .filter((item) => isCurrent(item, pathname))
    .map((item) => item.label);
}

describe("environment navigation", () => {
  test("shows a viewer every existing screen in sidebar order", () => {
    const viewer: ConsoleAuthorization = {
      capabilities: effectiveOrganizationCapabilities("viewer", PLATFORM_CLI_SCOPES),
      organizationRole: "viewer",
    };
    expect(environmentSidebar(viewer)).toEqual([
      ["Environment", ["Overview"]],
      ["Build", ["Agents", "Workflows", "Skills", "Apps"]],
      ["Operate", ["Runs", "Threads", "Approvals", "Automations", "Artifacts"]],
      ["Observe", ["Traces", "Metrics", "Evaluations", "Alerts"]],
      ["Connect", ["Integrate", "Connections", "MCP servers", "Extensions", "Email", "Webhooks"]],
      ["Knowledge", ["Brains", "Memory"]],
      ["Govern", ["Models", "Tool policies", "Audit log"]],
      ["Access", ["API keys", "Secrets", "Workspaces"]],
      ["Usage", ["Usage", "Budgets"]],
    ]);
  });

  test("ends with Settings for callers who may change the environment", () => {
    const sections = visibleSections(
      ENVIRONMENT_NAVIGATION,
      operationAccess({
        capabilities: effectiveOrganizationCapabilities("admin", PLATFORM_CLI_SCOPES),
        organizationRole: "admin",
      }),
    );
    expect(outline(sections).at(-1)).toEqual(["Settings", ["Settings"]]);
    expect(environmentHref("/o/$orgId/p/$projectId/e/$envId/settings", scope)).toBe(
      `${base}/settings`,
    );
  });

  test("lists only the screens the token permits", () => {
    const token = (capabilities: string[]): ConsoleAuthorization => ({
      capabilities,
      organizationRole: "member",
    });
    expect(environmentSidebar(token(["runs:read"]))).toEqual([["Operate", ["Runs", "Threads"]]]);
    expect(environmentSidebar(token(["service-accounts:read"]))).toEqual([]);
    expect(environmentSidebar(token(["service-accounts:read", "api-keys:read"]))).toEqual([
      ["Access", ["API keys"]],
    ]);
    expect(environmentSidebar({ capabilities: PLATFORM_CLI_SCOPES })).toEqual([]);
  });

  test("marks the item whose screen is open", () => {
    expect(currentItems(base)).toEqual(["Overview"]);
    expect(currentItems(`${base}/agents/agt1/tools`)).toEqual(["Agents"]);
    expect(currentItems(`${base}/skills/releases/rel1`)).toEqual(["Skills"]);
    expect(currentItems(`${base}/apps/app1`)).toEqual(["Apps"]);
    expect(currentItems(`${base}/runs`)).toEqual(["Runs"]);
    expect(currentItems(`${base}/threads`)).toEqual(["Threads"]);
    expect(currentItems(`${base}/threads/thr1`)).toEqual(["Threads"]);
    expect(currentItems(`${base}/metrics`)).toEqual(["Metrics"]);
    expect(currentItems(`${base}/memory/spaces/spc1`)).toEqual(["Memory"]);
    expect(currentItems(`${base}/metrics/extra`)).toEqual([]);
    expect(currentItems(`${base}/evaluations/runs/run1`)).toEqual(["Evaluations"]);
    expect(currentItems(`${base}/runs-archive`)).toEqual([]);
  });

  test("links each item into the selected environment", () => {
    expect(
      ENVIRONMENT_NAVIGATION.flatMap((section) => section.items)
        .slice(0, 3)
        .map((item) => environmentHref(item.to, scope)),
    ).toEqual([base, `${base}/agents`, `${base}/workflows`]);
  });
});

describe("organization navigation", () => {
  const access = (
    role: "admin" | "member" | "owner",
    capabilities: readonly string[] = effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
  ) => operationAccess({ capabilities, organizationRole: role });
  const labels = (edition: ConsoleEdition, role: "admin" | "member" | "owner") =>
    organizationLinks(edition, access(role), "org1", "/o/org1").map((link) => link.label);

  test("the default edition lists the console's organization screens the caller may use", () => {
    expect(labels(DEFAULT_CONSOLE_EDITION, "member")).toEqual([
      "Overview",
      "Members",
      "Usage and limits",
      "Data governance",
      "Alerts",
      "Audit log",
    ]);
    expect(labels(DEFAULT_CONSOLE_EDITION, "admin")).toEqual([
      "Overview",
      "Members",
      "Model keys",
      "Usage and limits",
      "Data governance",
      "Sign-in",
      "Alerts",
      "Audit log",
      "Settings",
    ]);
    expect(
      organizationLinks(
        DEFAULT_CONSOLE_EDITION,
        access("member", ["organizations:read"]),
        "org1",
        "/o/org1",
      ).map((link) => link.label),
    ).toEqual(["Overview", "Usage and limits"]);
    expect(
      organizationLinks(DEFAULT_CONSOLE_EDITION, access("member", []), "org1", "/o/org1"),
    ).toEqual([]);
  });

  test("a platform administrator sees Alerts exactly when the token carries monitors:read", () => {
    const administrator = (capabilities: readonly string[]) =>
      organizationLinks(
        DEFAULT_CONSOLE_EDITION,
        operationAccess({ capabilities, platformRole: "administrator" }),
        "org1",
        "/o/org1",
      ).map((link) => link.label);
    const withoutMonitors = PLATFORM_CLI_SCOPES.filter((scope) => !scope.startsWith("monitors:"));
    expect(administrator(PLATFORM_CLI_SCOPES)).toContain("Alerts");
    expect(administrator(withoutMonitors)).not.toContain("Alerts");
    expect(
      environmentSidebar({ capabilities: PLATFORM_CLI_SCOPES, platformRole: "administrator" }),
    ).toContainEqual(["Observe", expect.arrayContaining(["Alerts"])]);
    expect(
      environmentSidebar({ capabilities: withoutMonitors, platformRole: "administrator" }),
    ).toContainEqual(["Observe", ["Traces", "Metrics", "Evaluations"]]);
  });

  test("names the switcher's overview entry for the organization and links within it", () => {
    expect(
      organizationLinks(DEFAULT_CONSOLE_EDITION, access("owner"), "org1", "/o/org1/members").map(
        (link) => [link.switcher?.label ?? link.label, link.href, link.current],
      ),
    ).toEqual([
      ["Organization overview", "/o/org1", false],
      ["Members", "/o/org1/members", true],
      ["Model keys", "/o/org1/model-keys", false],
      ["Usage and limits", "/o/org1/usage", false],
      ["Data governance", "/o/org1/governance", false],
      ["Sign-in", "/o/org1/sign-in", false],
      ["Alerts", "/o/org1/alerts", false],
      ["Audit log", "/o/org1/audit", false],
      ["Settings", "/o/org1/settings", false],
    ]);
  });

  test("an edition drops the routes it did not mount and appends its own pages", () => {
    const edition: ConsoleEdition = {
      hiddenRoutes: ["/o/$orgId/audit", "/o/$orgId/sign-in"],
      install: "self-hosted",
      organizationNavigation: [
        {
          href: (organizationId) => `/o/${organizationId}/billing`,
          icon: Invoice01Icon,
          label: "Billing",
        },
        {
          gate: anyOf("putModelCredential"),
          href: (organizationId) => `/o/${organizationId}/keys-help`,
          icon: Invoice01Icon,
          label: "Key help",
        },
      ],
      productName: "Acme",
    };
    expect(labels(edition, "member")).toEqual([
      "Overview",
      "Members",
      "Usage and limits",
      "Data governance",
      "Alerts",
      "Billing",
    ]);
    expect(
      organizationLinks(edition, access("owner"), "org1", "/o/org1/billing/plans")
        .filter((link) => link.current)
        .map((link) => [link.label, link.href]),
    ).toEqual([["Billing", "/o/org1/billing"]]);
    expect(labels(edition, "owner").slice(-2)).toEqual(["Billing", "Key help"]);
  });

  test("an edition hides environment screens it did not mount", () => {
    const full = visibleSections(ENVIRONMENT_NAVIGATION, access("owner"));
    const hidden = visibleSections(ENVIRONMENT_NAVIGATION, access("owner"), [
      "/o/$orgId/p/$projectId/e/$envId/budgets",
    ]);
    const items = (sections: readonly NavSection<string>[]) =>
      sections.flatMap((section) => section.items.map((item) => item.label));
    expect(items(full).filter((label) => !items(hidden).includes(label))).toEqual(["Budgets"]);
  });
});
