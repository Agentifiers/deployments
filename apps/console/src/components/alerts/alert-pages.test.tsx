import {
  AlertIncidentResponse,
  AlertNotificationPreferencesResponse,
  MonitorResponse,
} from "@deployments-ai/api-contract/monitors";
import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { effectiveOrganizationCapabilities, type OrganizationRole } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { act, type ReactNode } from "react";
import { operationAccess } from "../../access.ts";
import {
  alertPreferencesQuery,
  incidentPagesQuery,
  incidentQuery,
  monitorPagesQuery,
  monitorQuery,
  monitorsRouteQuery,
} from "../../data/alert-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { memberDirectoryQuery } from "../../data/membership-queries.ts";
import { DEFAULT_CONSOLE_EDITION, type ConsoleRouterContext } from "../../edition.ts";
import type { EnvironmentSummary, OrganizationShell } from "../../server/console-data.ts";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { IncidentDetail, MonitorDetail } from "./alert-details.tsx";
import { IncidentList, MonitorList } from "./alert-lists.tsx";
import { AlertSettings } from "./alert-settings.tsx";
import { AlertsNotReadable } from "./alerts-not-readable.tsx";
import { CreateMonitorDialog } from "./monitor-dialogs.tsx";

const ORG = "01K000000000000000000000G1";
const PROJECT = "01K000000000000000000000J1";
const ENVIRONMENT = "01K000000000000000000000E1";
const MONITOR = "01K000000000000000000000M1";
const BUDGET_MONITOR = "01K000000000000000000000M2";
const INCIDENT = "01K000000000000000000000N1";
const AT = "2026-11-03T09:00:00.000Z";

function shell(role: OrganizationRole): OrganizationShell {
  return {
    access: operationAccess({
      capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
      organizationRole: role,
    }),
    authorization: { capabilities: [], organizationRole: role },
    organization: {
      createdAt: AT,
      id: Schema.decodeUnknownSync(PublicId)(ORG),
      name: "Acme",
      slug: Schema.decodeUnknownSync(Slug)("acme"),
      status: "active",
      updatedAt: AT,
    },
    organizations: [],
    principalId: "01K000000000000000000000U1",
    projects: [
      {
        environments: [
          {
            id: ENVIRONMENT,
            name: "Production",
            projectId: PROJECT,
            status: "active",
            type: "production",
          } as EnvironmentSummary,
        ],
        project: {
          id: PROJECT,
          name: "Support",
          status: "active",
        } as OrganizationShell["projects"][number]["project"],
      },
    ],
  };
}

const runMonitor = Schema.decodeUnknownSync(MonitorResponse)({
  condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
  createdAt: AT,
  environmentId: ENVIRONMENT,
  id: MONITOR,
  name: "Checkout failing",
  notify: { emailPrincipalIds: [], emailRoles: ["owner", "admin"], webhooks: true },
  organizationId: ORG,
  projectId: PROJECT,
  state: "firing",
  status: "active",
  updatedAt: AT,
  version: 2,
});

const budgetMonitor = Schema.decodeUnknownSync(MonitorResponse)({
  condition: { kind: "budget-threshold", minimumThreshold: 1 },
  createdAt: AT,
  id: BUDGET_MONITOR,
  name: "Budget alerts",
  notify: { emailPrincipalIds: [], emailRoles: ["owner", "admin", "billing"], webhooks: false },
  organizationId: ORG,
  state: "ok",
  status: "muted",
  updatedAt: AT,
  version: 1,
});

const incident = Schema.decodeUnknownSync(AlertIncidentResponse)({
  environmentId: ENVIRONMENT,
  id: INCIDENT,
  kind: "run-failures",
  monitorId: MONITOR,
  monitorName: "Checkout failing",
  openedAt: AT,
  organizationId: ORG,
  projectId: PROJECT,
  resolution: "condition-cleared",
  resolvedAt: "2026-11-03T09:30:00.000Z",
  status: "resolved",
  summary: "4 failed runs in the last 15 minutes (threshold 3).",
  timeline: [
    {
      at: AT,
      notified: true,
      summary: "4 failed runs in the last 15 minutes (threshold 3).",
      type: "fired",
      value: 4,
    },
    {
      at: "2026-11-03T09:30:00.000Z",
      notified: true,
      summary: "The condition cleared.",
      type: "resolved",
    },
  ],
});

function client(
  role: OrganizationRole,
  { monitorsRoute = "deployed" as const, morePages = false }: RenderOptions = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(organizationShellQuery(ORG).queryKey, shell(role));
  const page = <Item,>(items: readonly Item[], nextCursor?: string) => ({
    pageParams: [undefined],
    pages: [{ items, ...(nextCursor ? { nextCursor } : {}) }],
  });
  queryClient.setQueryData(
    monitorPagesQuery({ organizationId: ORG }).queryKey,
    page([runMonitor, budgetMonitor], morePages ? MONITOR : undefined),
  );
  queryClient.setQueryData(incidentPagesQuery({ organizationId: ORG }).queryKey, page([incident]));
  queryClient.setQueryData(monitorQuery(ORG, MONITOR).queryKey, runMonitor);
  queryClient.setQueryData(incidentQuery(ORG, MONITOR, INCIDENT).queryKey, incident);
  queryClient.setQueryData(memberDirectoryQuery(ORG).queryKey, []);
  queryClient.setQueryData(monitorsRouteQuery(ORG).queryKey, monitorsRoute);
  queryClient.setQueryData(
    alertPreferencesQuery(ORG).queryKey,
    Schema.decodeUnknownSync(AlertNotificationPreferencesResponse)({
      email: "all",
      mutedMonitorIds: [BUDGET_MONITOR],
    }),
  );
  return queryClient;
}

interface RenderOptions {
  readonly monitorsRoute?: "deployed" | "not_deployed";
  readonly morePages?: boolean;
  readonly role?: OrganizationRole;
}

async function render(
  ui: ReactNode,
  run: (view: ClientView) => Promise<void>,
  { role = "owner", ...options }: RenderOptions = {},
) {
  const queryClient = client(role, options);
  const root = createRootRouteWithContext<ConsoleRouterContext>()({ component: () => ui });
  const router = createRouter({
    context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  await withClient(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
    async (view) => {
      const window = view.document.defaultView;
      if (!window) throw new Error("withClient installs a window");
      Object.assign(window, { PointerEvent: window.MouseEvent });
      Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
      await run(view);
    },
  );
}

const cells = (view: ClientView) =>
  [...view.document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
  );

const buttonLabels = (view: ClientView) =>
  [...view.document.querySelectorAll("button")].map((button) => button.textContent?.trim());

describe("alert lists", () => {
  test("incidents show status, monitor, summary, place, and link to their timeline", async () => {
    await render(<IncidentList list={{ organizationId: ORG }} />, async (view) => {
      expect(cells(view).map((row) => row.slice(0, 4))).toEqual([
        [
          "Resolved",
          "Checkout failingRun failures",
          "4 failed runs in the last 15 minutes (threshold 3).",
          "Support / Production",
        ],
      ]);
      expect(view.document.querySelector("tbody a")?.getAttribute("href")).toBe(
        `/o/${ORG}/alerts/incidents/${MONITOR}/${INCIDENT}`,
      );
    });
  });

  test("monitors show their state, condition, place, and recipients", async () => {
    await render(<MonitorList list={{ organizationId: ORG }} />, async (view) => {
      expect(cells(view)).toEqual([
        [
          "Checkout failingRun failures",
          "Firing",
          "3+ failed runs in 15 min",
          "Support / Production",
          "Owners, Admins · Webhooks",
        ],
        [
          "Budget alertsBudget threshold",
          "Muted",
          "Threshold at or above 1%",
          "Organization",
          "Owners, Admins, Billing",
        ],
      ]);
    });
  });
});

describe("monitor detail", () => {
  test("owners can edit, mute, test, and archive", async () => {
    await render(<MonitorDetail monitorId={MONITOR} organizationId={ORG} />, async (view) => {
      expect(view.document.querySelector("h2")?.textContent).toBe("Checkout failing");
      expect(buttonLabels(view)).toEqual(
        expect.arrayContaining(["Edit", "Mute", "Send test", "Archive"]),
      );
      expect(view.document.body.textContent).toContain(
        "4 failed runs in the last 15 minutes (threshold 3).",
      );
    });
  });

  test("members read the monitor but get no actions", async () => {
    await render(
      <MonitorDetail monitorId={MONITOR} organizationId={ORG} />,
      async (view) => {
        expect(buttonLabels(view)).not.toContain("Edit");
        expect(buttonLabels(view)).not.toContain("Send test");
        expect(view.document.body.textContent).toContain("Owners and admins can change monitors.");
      },
      { role: "member" },
    );
  });
});

describe("incident detail", () => {
  test("the timeline lists each step and whether anyone was told", async () => {
    await render(
      <IncidentDetail incidentId={INCIDENT} monitorId={MONITOR} organizationId={ORG} />,
      async (view) => {
        const steps = [
          ...view.document.querySelectorAll("[aria-label='Incident timeline'] li"),
        ].map((item) => item.textContent ?? "");
        expect(steps).toHaveLength(2);
        expect(steps[0]).toContain("Fired");
        expect(steps[0]).toContain("Recipients notified");
        expect(steps[1]).toContain("Resolved");
        expect(view.document.body.textContent).toContain("The condition cleared.");
      },
    );
  });
});

describe("alert email settings", () => {
  test("shows the member's choice and the monitors they muted", async () => {
    await render(<AlertSettings organizationId={ORG} />, async (view) => {
      const checked = [...view.document.querySelectorAll("[data-slot=checkbox]")].map((box) =>
        box.getAttribute("aria-checked"),
      );
      expect(checked).toEqual(["false", "true"]);
      const save = [...view.document.querySelectorAll("button")].find(
        (button) => button.textContent === "Save settings",
      );
      expect(save?.hasAttribute("disabled")).toBe(true);
    });
  });

  test("offers the monitors past the first page for muting", async () => {
    await render(
      <AlertSettings organizationId={ORG} />,
      async (view) => {
        const more = [...view.document.querySelectorAll("button")].find(
          (button) => button.textContent === "Load more",
        );
        expect(more?.getAttribute("type")).toBe("button");
      },
      { morePages: true },
    );
  });
});

describe("alerts the caller cannot read", () => {
  test("an install without the monitors API says so instead of blaming the caller's scopes", async () => {
    await render(
      <AlertsNotReadable organizationId={ORG} />,
      async (view) => {
        expect(view.document.body.textContent).toContain(
          "Alerts are not available on this installation yet",
        );
        expect(view.document.body.textContent).not.toContain("monitors:read");
      },
      { monitorsRoute: "not_deployed" },
    );
  });

  test("a deployed API that refuses the caller names the missing scope", async () => {
    await render(<AlertsNotReadable organizationId={ORG} />, async (view) => {
      expect(view.document.body.textContent).toBe(
        "Your role or token scopes do not permit reading monitors (monitors:read).",
      );
    });
  });
});

describe("create monitor", () => {
  test("the form shows only the chosen kind's condition fields", async () => {
    await render(
      <CreateMonitorDialog onClose={() => {}} open organizationId={ORG} />,
      async (view) => {
        const inputs = () =>
          [...view.document.querySelectorAll<HTMLInputElement>("[role=dialog] input[name]")].map(
            (input) => input.name,
          );
        expect(inputs()).toEqual(["name", "threshold", "windowMinutes", "agentDeploymentId"]);
        const select = view.document.querySelector<HTMLSelectElement>("[role=dialog] select");
        if (!select) throw new Error("kind select missing");
        await act(async () => {
          select.value = "approval-wait";
          select.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
        expect(inputs()).toEqual(["name", "waitMinutes"]);
      },
    );
  });
});
