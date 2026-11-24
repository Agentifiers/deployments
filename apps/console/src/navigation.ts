import {
  AiBrain01Icon,
  ApiIcon,
  Audit01Icon,
  Brain02Icon,
  BubbleChatIcon,
  Building03Icon,
  ChartLineData01Icon,
  CheckmarkBadge01Icon,
  Coins01Icon,
  DashboardSquare01Icon,
  DatabaseIcon,
  File01Icon,
  Folder01Icon,
  Home01Icon,
  Key01Icon,
  LockKeyIcon,
  Login01Icon,
  Mail01Icon,
  McpServerIcon,
  Notification01Icon,
  PlayCircleIcon,
  Plug01Icon,
  PolicyIcon,
  PuzzleIcon,
  Robot01Icon,
  Route01Icon,
  Settings02Icon,
  Shield01Icon,
  TestTube01Icon,
  TimeScheduleIcon,
  UserGroupIcon,
  Wallet01Icon,
  WebhookIcon,
  WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ConsoleOperation, OperationAccess } from "./access.ts";
import type { ConsoleEdition } from "./edition.ts";
import type { FileRoutesByTo } from "./routeTree.gen.ts";
import { environmentPath, type EnvironmentScope } from "./scope.ts";

const ENVIRONMENT = "/o/$orgId/p/$projectId/e/$envId";
const ORGANIZATION = "/o/$orgId";

export type ConsoleRoute = keyof FileRoutesByTo;
export type EnvironmentRoute = Extract<ConsoleRoute, `${typeof ENVIRONMENT}${string}`>;
export type OrganizationRoute = Exclude<
  Extract<ConsoleRoute, `${typeof ORGANIZATION}${string}`>,
  EnvironmentRoute
>;
export type EnvironmentRouteWithoutIds = Exclude<
  EnvironmentRoute,
  `${typeof ENVIRONMENT}/${string}$${string}`
>;
export type OrganizationRouteWithoutIds = Exclude<
  OrganizationRoute,
  `${typeof ORGANIZATION}/${string}$${string}`
>;

export interface Gate {
  readonly kind: "allOf" | "anyOf";
  readonly operations: readonly [ConsoleOperation, ...ConsoleOperation[]];
}

export const anyOf = (...operations: [ConsoleOperation, ...ConsoleOperation[]]): Gate => ({
  kind: "anyOf",
  operations,
});
export const allOf = (...operations: [ConsoleOperation, ...ConsoleOperation[]]): Gate => ({
  kind: "allOf",
  operations,
});

export interface NavItem<To extends string, Pattern extends string = To> {
  readonly label: string;
  readonly icon: IconSvgElement;
  readonly to: To;
  readonly gate: Gate;
  readonly match: "exact" | "within";
  readonly alsoCurrentFor?: readonly Pattern[];
  readonly switcher?: { readonly label: string; readonly icon: IconSvgElement };
}

export interface NavSection<To extends string, Pattern extends string = To> {
  readonly heading: string;
  readonly items: readonly NavItem<To, Pattern>[];
}

export const ENVIRONMENT_NAVIGATION: readonly NavSection<
  EnvironmentRouteWithoutIds,
  EnvironmentRoute
>[] = [
  {
    heading: "Environment",
    items: [
      {
        gate: anyOf("getEnvironment"),
        icon: Home01Icon,
        label: "Overview",
        match: "exact",
        to: ENVIRONMENT,
      },
    ],
  },
  {
    heading: "Build",
    items: [
      {
        gate: anyOf("listAgentDefinitions"),
        icon: Robot01Icon,
        label: "Agents",
        match: "within",
        to: `${ENVIRONMENT}/agents`,
      },
      {
        gate: anyOf("listWorkflowDefinitions"),
        icon: WorkflowSquare01Icon,
        label: "Workflows",
        match: "within",
        to: `${ENVIRONMENT}/workflows`,
      },
      {
        gate: anyOf("listManagedSkillInstallations", "listManagedSkillSources"),
        icon: PuzzleIcon,
        label: "Skills",
        match: "within",
        to: `${ENVIRONMENT}/skills`,
      },
      {
        gate: anyOf("listApps"),
        icon: DashboardSquare01Icon,
        label: "Apps",
        match: "within",
        to: `${ENVIRONMENT}/apps`,
      },
    ],
  },
  {
    heading: "Operate",
    items: [
      {
        gate: anyOf("listRuns"),
        icon: PlayCircleIcon,
        label: "Runs",
        match: "within",
        to: `${ENVIRONMENT}/runs`,
      },
      {
        gate: anyOf("listThreads"),
        icon: BubbleChatIcon,
        label: "Threads",
        match: "within",
        to: `${ENVIRONMENT}/threads`,
      },
      {
        gate: anyOf("listApprovals"),
        icon: CheckmarkBadge01Icon,
        label: "Approvals",
        match: "within",
        to: `${ENVIRONMENT}/approvals`,
      },
      {
        gate: anyOf("listSchedules"),
        icon: TimeScheduleIcon,
        label: "Automations",
        match: "within",
        to: `${ENVIRONMENT}/automations`,
      },
      {
        gate: anyOf("listArtifacts"),
        icon: File01Icon,
        label: "Artifacts",
        match: "within",
        to: `${ENVIRONMENT}/artifacts`,
      },
    ],
  },
  {
    heading: "Observe",
    items: [
      {
        gate: anyOf("listObservabilityTraces"),
        icon: Route01Icon,
        label: "Traces",
        match: "within",
        to: `${ENVIRONMENT}/traces`,
      },
      {
        gate: anyOf("getObservabilityMetrics"),
        icon: ChartLineData01Icon,
        label: "Metrics",
        match: "exact",
        to: `${ENVIRONMENT}/metrics`,
      },
      {
        gate: anyOf("listEvaluationRuns"),
        icon: TestTube01Icon,
        label: "Evaluations",
        match: "within",
        to: `${ENVIRONMENT}/evaluations`,
      },
      {
        gate: anyOf("listMonitors"),
        icon: Notification01Icon,
        label: "Alerts",
        match: "exact",
        to: `${ENVIRONMENT}/alerts`,
      },
    ],
  },
  {
    heading: "Connect",
    items: [
      {
        gate: anyOf("getEnvironment"),
        icon: ApiIcon,
        label: "Integrate",
        match: "exact",
        to: `${ENVIRONMENT}/integrate`,
      },
      {
        gate: anyOf("listProviderConnections"),
        icon: Plug01Icon,
        label: "Connections",
        match: "within",
        to: `${ENVIRONMENT}/connections`,
      },
      {
        gate: anyOf("listMcpServers"),
        icon: McpServerIcon,
        label: "MCP servers",
        match: "within",
        to: `${ENVIRONMENT}/mcp-servers`,
      },
      {
        gate: anyOf("listExtensionTools"),
        icon: PuzzleIcon,
        label: "Extensions",
        match: "within",
        to: `${ENVIRONMENT}/extensions`,
      },
      {
        gate: anyOf("listAgentEmailInboxes", "listEmailTenants"),
        icon: Mail01Icon,
        label: "Email",
        match: "within",
        to: `${ENVIRONMENT}/email`,
      },
      {
        gate: anyOf("listWebhooks"),
        icon: WebhookIcon,
        label: "Webhooks",
        match: "within",
        to: `${ENVIRONMENT}/webhooks`,
      },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      {
        gate: anyOf("listBrains"),
        icon: Brain02Icon,
        label: "Brains",
        match: "within",
        to: `${ENVIRONMENT}/brains`,
      },
      {
        gate: anyOf("listMemorySpaces"),
        icon: DatabaseIcon,
        label: "Memory",
        match: "within",
        to: `${ENVIRONMENT}/memory`,
      },
    ],
  },
  {
    heading: "Govern",
    items: [
      {
        gate: anyOf("listModels"),
        icon: AiBrain01Icon,
        label: "Models",
        match: "within",
        to: `${ENVIRONMENT}/models`,
      },
      {
        gate: anyOf("listToolPolicies", "listTools"),
        icon: PolicyIcon,
        label: "Tool policies",
        match: "within",
        to: `${ENVIRONMENT}/tool-policies`,
      },
      {
        gate: anyOf("listAuditEvents"),
        icon: Audit01Icon,
        label: "Audit log",
        match: "within",
        to: `${ENVIRONMENT}/audit`,
      },
    ],
  },
  {
    heading: "Access",
    items: [
      {
        gate: allOf("listServiceAccounts", "listApiCredentials"),
        icon: Key01Icon,
        label: "API keys",
        match: "within",
        to: `${ENVIRONMENT}/api-keys`,
      },
      {
        gate: anyOf("listCredentialReferences"),
        icon: LockKeyIcon,
        label: "Secrets",
        match: "exact",
        to: `${ENVIRONMENT}/secrets`,
      },
      {
        gate: anyOf("listWorkspaces"),
        icon: Folder01Icon,
        label: "Workspaces",
        match: "exact",
        to: `${ENVIRONMENT}/workspaces`,
      },
    ],
  },
  {
    heading: "Usage",
    items: [
      {
        gate: anyOf("getUsageSummary"),
        icon: Coins01Icon,
        label: "Usage",
        match: "exact",
        to: `${ENVIRONMENT}/usage`,
      },
      {
        gate: anyOf("listBudgets"),
        icon: Wallet01Icon,
        label: "Budgets",
        match: "within",
        to: `${ENVIRONMENT}/budgets`,
      },
    ],
  },
  {
    heading: "Settings",
    items: [
      {
        gate: anyOf("updateEnvironment", "archiveEnvironment"),
        icon: Settings02Icon,
        label: "Settings",
        match: "exact",
        to: `${ENVIRONMENT}/settings`,
      },
    ],
  },
];

export const ORGANIZATION_NAVIGATION: NavSection<OrganizationRouteWithoutIds> = {
  heading: "Organization",
  items: [
    {
      gate: anyOf("getOrganization"),
      icon: Home01Icon,
      label: "Overview",
      match: "exact",
      switcher: { icon: Building03Icon, label: "Organization overview" },
      to: ORGANIZATION,
    },
    {
      gate: allOf("getOrganization", "listOrganizationMembers"),
      icon: UserGroupIcon,
      label: "Members",
      match: "within",
      to: `${ORGANIZATION}/members`,
    },
    {
      gate: anyOf("getModelCredential"),
      icon: Key01Icon,
      label: "Model keys",
      match: "exact",
      to: `${ORGANIZATION}/model-keys`,
    },
    {
      gate: anyOf("getOrganizationSpend", "getOrganizationLimits"),
      icon: ChartLineData01Icon,
      label: "Usage and limits",
      match: "exact",
      to: `${ORGANIZATION}/usage`,
    },
    {
      gate: anyOf("getOrganizationRetentionPolicy", "listGovernanceOperations"),
      icon: Shield01Icon,
      label: "Data governance",
      match: "within",
      to: `${ORGANIZATION}/governance`,
    },
    {
      gate: anyOf("getIdentityProvider", "listLoginDomains"),
      icon: Login01Icon,
      label: "Sign-in",
      match: "exact",
      to: `${ORGANIZATION}/sign-in`,
    },
    {
      gate: anyOf("listMonitors"),
      icon: Notification01Icon,
      label: "Alerts",
      match: "within",
      to: `${ORGANIZATION}/alerts`,
    },
    {
      gate: anyOf("listOrganizationAuditEvents"),
      icon: Audit01Icon,
      label: "Audit log",
      match: "exact",
      to: `${ORGANIZATION}/audit`,
    },
    {
      gate: anyOf("updateOrganization", "updateProject", "createTenantErasure"),
      icon: Settings02Icon,
      label: "Settings",
      match: "exact",
      to: `${ORGANIZATION}/settings`,
    },
  ],
};

function permits(gate: Gate, access: OperationAccess): boolean {
  return gate.kind === "anyOf"
    ? gate.operations.some((operation) => access[operation])
    : gate.operations.every((operation) => access[operation]);
}

/** Sections without the items the caller may not use or the host did not mount. */
export function visibleSections<To extends string, Pattern extends string>(
  sections: readonly NavSection<To, Pattern>[],
  access: OperationAccess,
  hiddenRoutes: readonly string[] = [],
): readonly NavSection<To, Pattern>[] {
  return sections.flatMap((section) => {
    const items = section.items.filter(
      (item) => permits(item.gate, access) && !hiddenRoutes.includes(item.to),
    );
    return items.length === 0 ? [] : [{ heading: section.heading, items }];
  });
}

export interface OrganizationLink {
  readonly current: boolean;
  readonly href: string;
  readonly icon: IconSvgElement;
  readonly label: string;
  readonly switcher?: { readonly label: string; readonly icon: IconSvgElement };
}

/** The organization sidebar: the console's pages the edition kept, then the edition's own. */
export function organizationLinks(
  edition: ConsoleEdition,
  access: OperationAccess,
  organizationId: string,
  pathname: string,
): readonly OrganizationLink[] {
  const consolePages = visibleSections([ORGANIZATION_NAVIGATION], access, edition.hiddenRoutes)
    .flatMap((section) => section.items)
    .map((item) => ({
      current: isCurrent(item, pathname),
      href: organizationHref(item.to, organizationId),
      icon: item.icon,
      label: item.label,
      ...(item.switcher ? { switcher: item.switcher } : {}),
    }));
  const hostPages = edition.organizationNavigation
    .filter((item) => item.gate === undefined || permits(item.gate, access))
    .map(({ href, icon, label }) => {
      const path = href(organizationId);
      return { current: matchesRoute(path, pathname, "within"), href: path, icon, label };
    });
  return [...consolePages, ...hostPages];
}

export function environmentHref(to: EnvironmentRouteWithoutIds, scope: EnvironmentScope): string {
  return `${environmentPath(scope)}${to.slice(ENVIRONMENT.length)}`;
}

export function organizationHref(to: OrganizationRouteWithoutIds, organizationId: string): string {
  return `/o/${organizationId}${to.slice(ORGANIZATION.length)}`;
}

function matchesRoute(template: string, pathname: string, match: "exact" | "within"): boolean {
  const expected = template.split("/");
  const actual = pathname.split("/");
  if (match === "exact" ? actual.length !== expected.length : actual.length < expected.length) {
    return false;
  }
  return expected.every((segment, index) =>
    segment.startsWith("$") ? actual[index] !== "" : segment === actual[index],
  );
}

export function isCurrent(item: NavItem<string>, pathname: string): boolean {
  return (
    matchesRoute(item.to, pathname, item.match) ||
    (item.alsoCurrentFor ?? []).some((template) => matchesRoute(template, pathname, "within"))
  );
}
