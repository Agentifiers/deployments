import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { operationAccess } from "../../access.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { directoryQuery } from "../../data/directory-sync-queries.ts";
import { organizationStandingQuery } from "../../data/organization-account-queries.ts";
import {
  identityProviderLinksQuery,
  identityProviderQuery,
  loginDomainsQuery,
} from "../../data/sign-in-queries.ts";
import {
  DEFAULT_CONSOLE_EDITION,
  INSTALL_COPY,
  type ConsoleEdition,
  type ConsoleRouterContext,
} from "../../edition.ts";
import { Route as SignInRoute } from "../../routes/o.$orgId.sign-in.tsx";
import type { OrganizationShell } from "../../server/console-data.ts";
import type { OrganizationStanding } from "../../server/organization-account-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { renderWith } from "../apps/app-fixtures.tsx";

const ORG = Schema.decodeUnknownSync(PublicId)("01K000000000000000000000G1");
const AT = "2026-10-01T00:00:00.000Z";

const shell: OrganizationShell = {
  access: operationAccess({
    capabilities: effectiveOrganizationCapabilities("owner", PLATFORM_CLI_SCOPES),
    organizationRole: "owner",
  }),
  authorization: { capabilities: [], organizationRole: "owner" },
  organization: {
    createdAt: AT,
    id: ORG,
    name: "Acme",
    slug: Schema.decodeUnknownSync(Slug)("acme"),
    status: "active",
    updatedAt: AT,
  },
  organizations: [],
  principalId: "01K000000000000000000000U1",
  projects: [],
};

const standing = (
  features: OrganizationStanding["effective"]["features"],
): OrganizationStanding => ({
  dataBoundary: null,
  effective: {
    features,
    operatorFundedModelSpendCeiling: "unlimited",
    tenantLimits: {
      activeSandboxes: 8,
      apiRequestBurst: 40,
      apiRequestsPerSecond: 20,
      concurrentRuns: 8,
    },
  },
  holds: [],
  organizationId: ORG,
  state: "active",
  suspendedAt: null,
});

async function signIn(
  edition: ConsoleEdition,
  features: OrganizationStanding["effective"]["features"],
  run: (view: ClientView) => Promise<void>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(organizationShellQuery(ORG).queryKey, shell);
  queryClient.setQueryData(organizationStandingQuery(ORG).queryKey, standing(features));
  queryClient.setQueryData(loginDomainsQuery(ORG).queryKey, []);
  queryClient.setQueryData(identityProviderQuery(ORG).queryKey, null);
  queryClient.setQueryData(identityProviderLinksQuery(ORG).queryKey, {
    pageParams: [undefined],
    pages: [{ items: [] }],
  });
  queryClient.setQueryData(directoryQuery(ORG).queryKey, null);
  const { component } = SignInRoute.options;
  if (!component) throw new Error("the sign-in route renders a component");
  const root = createRootRouteWithContext<ConsoleRouterContext>()();
  const page = createRoute({ component, getParentRoute: () => root, path: "/o/$orgId/sign-in" });
  const router = createRouter({
    context: { edition, queryClient },
    history: createMemoryHistory({ initialEntries: [`/o/${ORG}/sign-in`] }),
    routeTree: root.addChildren([page]),
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

const buttons = (view: ClientView) =>
  [...view.document.querySelectorAll("main button, section button")].map((node) =>
    node.textContent?.trim(),
  );
const notices = (view: ClientView) =>
  [...view.document.querySelectorAll("[role=status]")].map((node) => node.textContent);

describe("Sign-in page by plan", () => {
  test("a plan with every feature offers setup and shows no plan notice", async () => {
    await signIn(DEFAULT_CONSOLE_EDITION, { scim: true, sso: true }, async (view) => {
      expect(notices(view)).toEqual([]);
      expect(buttons(view)).toEqual(["Set up", "Add domain", "Turn on"]);
    });
  });

  test("a managed plan without sso or scim hides setup and says to upgrade", async () => {
    const managed: ConsoleEdition = { ...DEFAULT_CONSOLE_EDITION, install: "managed" };
    await signIn(managed, { scim: false, sso: false }, async (view) => {
      expect(buttons(view)).toEqual([]);
      expect(notices(view)).toEqual([
        `Single sign-on is not included in your planYou can review and remove the current setup. ${INSTALL_COPY.managed.featureNotInPlan}`,
        `Directory sync is not included in your planYou can review and remove the current setup. ${INSTALL_COPY.managed.featureNotInPlan}`,
      ]);
    });
  });

  test("a self-hosted install without scim points to the administrator and keeps sso", async () => {
    await signIn(DEFAULT_CONSOLE_EDITION, { scim: false, sso: true }, async (view) => {
      expect(buttons(view)).toEqual(["Set up", "Add domain"]);
      expect(notices(view)).toEqual([
        `Directory sync is not included in your planYou can review and remove the current setup. ${INSTALL_COPY["self-hosted"].featureNotInPlan}`,
      ]);
    });
  });
});
