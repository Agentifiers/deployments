import type { ModelCredentialProvider } from "@deployments-ai/api-contract/models";
import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { operationAccess } from "../../access.ts";
import { createConsoleRouter } from "../../console-router.tsx";
import {
  organizationShellQuery,
  organizationsQuery,
  platformAdministratorQuery,
} from "../../data/console-queries.ts";
import * as keyMutations from "../../data/model-key-mutations.ts";
import { modelKeysQuery } from "../../data/model-key-queries.ts";
import * as accountQueries from "../../data/organization-account-queries.ts";
import {
  organizationLimitsQuery,
  organizationSpendQuery,
} from "../../data/organization-account-queries.ts";
import {
  DEFAULT_CONSOLE_EDITION,
  type ConsoleEdition,
  type ConsoleRouterContext,
} from "../../edition.ts";
import { PlatformApiError } from "../../errors.ts";
import type { ModelKey } from "../../models/model-keys.ts";
import { Route as OverviewRoute } from "../../routes/o.$orgId.index.tsx";
import type { OrganizationShell } from "../../server/console-data.ts";
import type {
  OrganizationLimits,
  OrganizationSpend,
  OrganizationStanding,
} from "../../server/organization-account-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { renderWith, typeInto } from "../apps/app-fixtures.tsx";
import { ModelKeys } from "../models/model-keys.tsx";
import { TIMESTAMP_FORMAT } from "../observability/panels.tsx";
import { OrganizationNotices } from "./organization-notices.tsx";
import { OrganizationPicker } from "./organization-picker.tsx";
import { OrganizationLimitsSection, OrganizationSpendSection } from "./organization-usage.tsx";

const ORG = Schema.decodeUnknownSync(PublicId)("01K000000000000000000000G1");
const SLUG = Schema.decodeUnknownSync(Slug)("acme");
const AT = "2026-10-09T12:00:00.000Z";

const saved: Record<string, unknown>[] = [];
spyOn(keyMutations, "setModelKeyFn").mockImplementation((async ({
  data,
}: {
  readonly data: Record<string, unknown>;
}) => {
  saved.push(data);
  return { lastFour: "1234", provider: data["provider"], setAt: AT, state: "set" };
}) as unknown as typeof keyMutations.setModelKeyFn);

let readStanding: () => Promise<OrganizationStanding> = () =>
  Promise.reject(new Error("the test sets the standing read"));
const realStandingQuery = accountQueries.organizationStandingQuery;
spyOn(accountQueries, "organizationStandingQuery").mockImplementation((organizationId) => ({
  ...realStandingQuery(organizationId),
  queryFn: () => readStanding(),
}));
afterAll(() => {
  mock.restore();
});

const unavailable = () =>
  Promise.reject(
    new PlatformApiError("getOrganizationStanding", {
      requestId: "req-standing",
      status: 503,
      title: "Service Unavailable",
    }),
  );

const access = (role: "member" | "owner") =>
  operationAccess({
    capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
    organizationRole: role,
  });

const text = (view: ClientView, selector: string) =>
  [...view.document.querySelectorAll(selector)].map((node) => node.textContent?.trim());

interface Host {
  readonly component: () => ReactNode;
  readonly edition: ConsoleEdition;
  readonly seed: (queryClient: QueryClient) => void;
}

/** A host app: its own root route, the console's router settings, and the given edition. */
function HostApp({ component, edition, seed }: Host) {
  const [router] = useState(() => {
    const created = createConsoleRouter({
      edition,
      routeTree: createRootRouteWithContext<ConsoleRouterContext>()({ component }),
    });
    seed(created.options.context.queryClient);
    return created;
  });
  return <RouterProvider router={router} />;
}

const renderHost = (host: Host, run: (view: ClientView) => Promise<void>) =>
  renderWith(new QueryClient(), <HostApp {...host} />, run);

describe("console edition", () => {
  const seed = (queryClient: QueryClient) => {
    queryClient.setQueryData(organizationsQuery().queryKey, [
      { createdAt: AT, id: ORG, name: "Acme", slug: SLUG, status: "active", updatedAt: AT },
    ]);
    queryClient.setQueryData(platformAdministratorQuery().queryKey, true);
  };

  test("the default edition shows a platform administrator the System link on the picker", async () => {
    await renderHost(
      { component: OrganizationPicker, edition: DEFAULT_CONSOLE_EDITION, seed },
      async (view) => {
        expect(text(view, "main button, main a[href='/system']")).toEqual([
          "System",
          "Create organization",
          "Sign out",
        ]);
      },
    );
  });

  test("a host router with its own tree and an edition without /system renders the picker without operator actions", async () => {
    const edition: ConsoleEdition = {
      ...DEFAULT_CONSOLE_EDITION,
      hiddenRoutes: ["/system"],
      productName: "Acme Cloud",
    };
    await renderHost({ component: OrganizationPicker, edition, seed }, async (view) => {
      expect(text(view, "main button, main a[href='/system']")).toEqual([
        "Create organization",
        "Sign out",
      ]);
      expect(text(view, "main li a")).toEqual(["AcAcmeacme"]);
    });
  });
});

const standing = (
  state: "active" | "suspended",
  dataBoundary: OrganizationStanding["dataBoundary"] = null,
): OrganizationStanding => ({
  dataBoundary,
  effective: {
    features: { scim: true, sso: true },
    operatorFundedModelSpendCeiling: { monthlyUsdMicros: 0 },
    tenantLimits: {
      activeSandboxes: 2,
      apiRequestBurst: 50,
      apiRequestsPerSecond: 10,
      concurrentRuns: 2,
    },
  },
  holds:
    state === "active"
      ? []
      : [
          {
            customerMessage: "Pay the overdue invoice to resume runs.",
            reason: "payment",
            since: AT,
          },
          {
            customerMessage: "Our team is reviewing recent traffic.",
            reason: "abuse",
            since: AT,
          },
        ],
  organizationId: ORG,
  state,
  suspendedAt: state === "active" ? null : AT,
});

describe("organization overview", () => {
  async function header(read: () => Promise<OrganizationStanding>) {
    readStanding = read;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shell: OrganizationShell = {
      access: access("member"),
      authorization: { capabilities: [], organizationRole: "member" },
      organization: {
        createdAt: AT,
        id: ORG,
        name: "Acme",
        slug: SLUG,
        status: "active",
        updatedAt: AT,
      },
      organizations: [],
      principalId: "01K000000000000000000000P1",
      projects: [],
    };
    queryClient.setQueryData(organizationShellQuery(ORG).queryKey, shell);
    const { component } = OverviewRoute.options;
    if (!component) throw new Error("the overview route renders a component");
    const root = createRootRouteWithContext<ConsoleRouterContext>()();
    const organization = createRoute({ getParentRoute: () => root, path: "/o/$orgId" });
    const overview = createRoute({ component, getParentRoute: () => organization, path: "/" });
    const router = createRouter({
      context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
      history: createMemoryHistory({ initialEntries: [`/o/${ORG}`] }),
      routeTree: root.addChildren([organization.addChildren([overview])]),
    });
    await router.load();
    let shown: (string | undefined)[] = [];
    await renderWith(queryClient, <RouterProvider router={router} />, async (view) => {
      shown = text(view, "h1, h1 + [data-slot=badge]");
    });
    return shown;
  }

  test("an organization in good standing shows its lifecycle status beside its name", async () => {
    expect(await header(async () => standing("active"))).toEqual(["Acme", "Active"]);
  });

  test("a suspended organization shows suspended beside its name, not its lifecycle status", async () => {
    expect(await header(async () => standing("suspended"))).toEqual(["Acme", "Suspended"]);
  });

  test("an organization whose standing failed to load shows no status beside its name", async () => {
    expect(await header(unavailable)).toEqual(["Acme"]);
  });
});

describe("organization notices", () => {
  const notices = {
    component: () => <OrganizationNotices access={access("member")} organizationId={ORG} />,
    edition: {
      ...DEFAULT_CONSOLE_EDITION,
      organizationNotice: ({ organizationId }: { readonly organizationId: string }) => (
        <p data-notice>Invoice due for {organizationId}</p>
      ),
    },
    seed: () => {},
  };
  const order = (view: ClientView) =>
    [...view.document.querySelectorAll("[role=alert], [role=status], [data-notice]")].map(
      (node) => node.getAttribute("role") ?? node.textContent,
    );

  test("a suspended organization shows each hold's reason and customer message, then the edition's notice", async () => {
    readStanding = async () => standing("suspended");
    await renderHost(notices, async (view) => {
      expect(order(view)).toEqual(["alert", `Invoice due for ${ORG}`]);
      expect(text(view, "[role=alert] h4")).toEqual(["This organization is suspended"]);
      expect(
        text(view, "[role=alert] li").map((item) =>
          item?.replace(new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT), "<since>"),
        ),
      ).toEqual([
        "Payment since <since>. Pay the overdue invoice to resume runs.",
        "Abuse review since <since>. Our team is reviewing recent traffic.",
      ]);
    });
  });

  test("an organization in good standing shows only the edition's notice", async () => {
    readStanding = async () => standing("active");
    await renderHost(notices, async (view) => {
      expect(order(view)).toEqual([`Invoice due for ${ORG}`]);
    });
  });

  test("an organization under a PHI boundary tells members what is unavailable and since when", async () => {
    readStanding = async () => standing("active", { profile: "phi", since: AT });
    await renderHost(notices, async (view) => {
      expect(order(view)).toEqual(["status", `Invoice due for ${ORG}`]);
      expect(text(view, "[role=status] h4")).toEqual([
        "This organization is under a PHI data boundary",
      ]);
      expect(
        text(view, "[role=status] [data-slot=alert-description]").map((item) =>
          item?.replace(new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT), "<since>"),
        ),
      ).toEqual([
        "Tools that reach the public internet and models outside Bedrock are unavailable. In place since <since>.",
      ]);
    });
  });

  test("a failed standing read says the status could not be loaded, and Retry loads it", async () => {
    readStanding = unavailable;
    await renderHost(notices, async (view) => {
      expect(order(view)).toEqual(["status", `Invoice due for ${ORG}`]);
      expect(text(view, "[role=status] h4")).toEqual(["Organization status could not be loaded"]);
      expect(text(view, "[role=status] [data-slot=alert-description]")).toEqual([
        "Any suspension notice appears here once the status loads.Status 503 · Request req-standing",
      ]);
      readStanding = async () => standing("suspended");
      await view.click(view.document.querySelector("[role=status] button"));
      expect(order(view)).toEqual(["alert", `Invoice due for ${ORG}`]);
      expect(text(view, "[role=alert] h4")).toEqual(["This organization is suspended"]);
    });
  });
});

describe("usage and limits", () => {
  const spend = (operatorFundedUsdMicros: number): OrganizationSpend => ({
    asOf: AT,
    month: "2026-10",
    operatorFundedModelSpendCeiling: { monthlyUsdMicros: 50_000_000 },
    operatorFundedUsdMicros,
    organizationFundedUsdMicros: 3_250_000,
    organizationId: ORG,
    periodStart: "2026-10-01T00:00:00.000Z",
    totalUsdMicros: operatorFundedUsdMicros + 3_250_000,
  });
  const limits: OrganizationLimits = {
    activeSandboxes: { source: "default", value: 4 },
    apiRequestBurst: { source: "plan", value: 100 },
    apiRequestsPerSecond: { source: "default", value: 20 },
    concurrentRuns: { source: "override", value: 12 },
  };
  const client = (operatorFundedUsdMicros: number) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    queryClient.setQueryData(organizationSpendQuery(ORG).queryKey, spend(operatorFundedUsdMicros));
    queryClient.setQueryData(organizationLimitsQuery(ORG).queryKey, limits);
    return queryClient;
  };
  const page = (
    <>
      <OrganizationSpendSection organizationId={ORG} />
      <OrganizationLimitsSection organizationId={ORG} />
    </>
  );

  test("shows operator-funded spend against the ceiling, organization-funded spend, and effective limits", async () => {
    await renderWith(client(12_500_000), page, async (view) => {
      expect(text(view, "[data-slot=card-content]")).toEqual([
        "Paid by the installation$12.5025% of the $50.00 monthly ceiling",
        "Paid with organization keys$3.25Model calls on the organization's keys, at catalog prices",
        "Total$15.75",
      ]);
      expect(view.document.querySelector("[role=status], [role=alert]")).toBeNull();
      expect(
        [...view.document.querySelectorAll("tbody tr")].map((row) =>
          [...row.querySelectorAll("td")].map((cell) => cell.textContent),
        ),
      ).toEqual([
        ["Concurrent runs", "12", "Custom"],
        ["Active sandboxes", "4", "Default"],
        ["API requests per second", "20", "Default"],
        ["API request burst", "100", "Plan"],
      ]);
    });
  });

  test("warns once operator-funded spend reaches the ceiling", async () => {
    await renderWith(client(50_000_000), page, async (view) => {
      expect(text(view, "[data-slot=card-content]")[0]).toBe(
        "Paid by the installation$50.00100% of the $50.00 monthly ceiling",
      );
      expect(text(view, "h4")).toEqual(["The monthly ceiling is reached"]);
    });
  });
});

describe("model keys", () => {
  const keys: readonly ModelKey[] = [
    { label: "Production", lastFour: "9xQz", provider: "openai", setAt: AT, state: "set" },
    { provider: "openrouter", state: "unset" },
  ];
  const client = (shown: readonly ModelKey[]) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(modelKeysQuery(ORG).queryKey, [...shown]);
    return queryClient;
  };
  const rows = (view: ClientView) =>
    [...view.document.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) =>
        cell.textContent?.replace(
          new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT),
          "<set>",
        ),
      ),
    );

  test("owners set, replace, and remove keys; a provider the installation lacks shows that", async () => {
    const shown: readonly ModelKey[] = [
      ...keys.slice(0, 1),
      { provider: "openrouter", state: "not-enabled" },
    ];
    await renderWith(
      client(shown),
      <ModelKeys access={access("owner")} organizationId={ORG} />,
      async (view) => {
        expect(rows(view)).toEqual([
          ["OpenAI", "Set…9xQzProduction", "<set>", "ReplaceRemove"],
          ["OpenRouter", "Not enabledThis installation does not accept OpenRouter keys.", "—", ""],
        ]);
      },
    );
  });

  test("a token with models:read but not models:write sees the keys without actions", async () => {
    const readOnly = {
      ...access("owner"),
      deleteModelCredential: false,
      putModelCredential: false,
    };
    await renderWith(
      client(keys),
      <ModelKeys access={readOnly} organizationId={ORG} />,
      async (view) => {
        expect(rows(view).map((row) => row.at(-1))).toEqual(["", ""]);
      },
    );
  });

  test("the add dialog names each provider in its title", async () => {
    const titles: Record<ModelCredentialProvider, string> = {
      openai: "Add a key for OpenAI",
      openrouter: "Add a key for OpenRouter",
    };
    const shown: string[] = [];
    for (const provider of Object.keys(titles) as ModelCredentialProvider[]) {
      await renderWith(
        client([{ provider, state: "unset" }]),
        <ModelKeys access={access("owner")} organizationId={ORG} />,
        async (view) => {
          await view.click(
            [...view.document.querySelectorAll("button")].find(
              (node) => node.textContent === "Add key",
            ),
          );
          shown.push(...text(view, "[data-slot=dialog-title]").map(String));
        },
      );
    }
    expect(shown).toEqual(Object.values(titles));
  });

  test("a saved key is sent once and is gone from the page after the dialog closes", async () => {
    const secret = "sk-or-v1-secret-value-1234";
    await renderWith(
      client(keys),
      <ModelKeys access={access("owner")} organizationId={ORG} />,
      async (view) => {
        await view.click(
          [...view.document.querySelectorAll("button")].find(
            (node) => node.textContent === "Add key",
          ),
        );
        await typeInto(view, "apiKey", secret);
        await view.click(
          [...view.document.querySelectorAll("button")].find(
            (node) => node.textContent === "Save key",
          ),
        );
        expect(saved).toEqual([
          {
            body: { apiKey: secret },
            idempotencyKey: expect.any(String),
            provider: "openrouter",
            scope: { organizationId: ORG },
          },
        ]);
        expect(view.document.querySelector("input[name=apiKey]")).toBeNull();
        expect(view.document.body.innerHTML.includes(secret)).toBe(false);
      },
    );
  });
});
