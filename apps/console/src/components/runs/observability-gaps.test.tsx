import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import type { ReactNode } from "react";
import { operationAccess } from "../../access.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import * as threadMutations from "../../data/thread-mutations.ts";
import { artifactPagesQuery } from "../../data/thread-queries.ts";
import {
  DEFAULT_CONSOLE_EDITION,
  INSTALL_COPY,
  type ConsoleEdition,
  type ConsoleRouterContext,
} from "../../edition.ts";
import { PlatformApiError } from "../../errors.ts";
import type { Artifact } from "../../server/artifact-data.ts";
import type { EnvironmentSummary, OrganizationShell } from "../../server/console-data.ts";
import type { Thread } from "../../server/runtime-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { buttons, renderWith, typeInto } from "../apps/app-fixtures.tsx";
import { EndUserErasureSection } from "../governance/end-user-erasure.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ArtifactList } from "./artifact-list.tsx";
import { ThreadActions } from "./thread-actions.tsx";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
const AT = "2026-10-09T12:00:00.000Z";
const THREAD = "01K000000000000000000000T1";
const ARTIFACT = "01K000000000000000000000F1";

const shell: OrganizationShell = {
  access: operationAccess({
    capabilities: effectiveOrganizationCapabilities("owner", PLATFORM_CLI_SCOPES),
    organizationRole: "owner",
  }),
  authorization: { capabilities: [], organizationRole: "owner" },
  organization: {
    createdAt: AT,
    id: Schema.decodeUnknownSync(PublicId)(scope.organizationId),
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
        { id: scope.environmentId, name: "Production", status: "active" } as EnvironmentSummary,
      ],
      project: {
        id: scope.projectId,
        name: "Support",
      } as OrganizationShell["projects"][number]["project"],
    },
  ],
};

const calls: { readonly fn: string; readonly data: unknown }[] = [];
spyOn(threadMutations, "eraseThreadFn").mockImplementation((({ data }: { data: unknown }) => {
  calls.push({ data, fn: "eraseThread" });
  return Promise.resolve({ id: "01K000000000000000000000X1" });
}) as unknown as typeof threadMutations.eraseThreadFn);
spyOn(threadMutations, "eraseEndUserFn").mockImplementation((({ data }: { data: unknown }) => {
  calls.push({ data, fn: "eraseEndUser" });
  return Promise.resolve({ id: "01K000000000000000000000X2" });
}) as unknown as typeof threadMutations.eraseEndUserFn);
spyOn(threadMutations, "createArtifactLinkFn").mockImplementation((({
  data,
}: {
  data: unknown;
}) => {
  calls.push({ data, fn: "createArtifactLink" });
  return Promise.resolve({ expiresAt: AT, url: "https://files.example.com/report.pdf?sig=1" });
}) as unknown as typeof threadMutations.createArtifactLinkFn);
afterEach(() => {
  calls.length = 0;
});
afterAll(() => {
  mock.restore();
});

async function inRouter(
  ui: ReactNode,
  run: (view: ClientView) => Promise<void>,
  {
    edition = DEFAULT_CONSOLE_EDITION,
    seed = () => {},
  }: { edition?: ConsoleEdition; seed?: (client: QueryClient) => void } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(organizationShellQuery(scope.organizationId).queryKey, shell);
  seed(queryClient);
  const root = createRootRouteWithContext<ConsoleRouterContext>()({ component: () => ui });
  const router = createRouter({
    context: { edition, queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

const confirmButton = (view: ClientView, label: string) =>
  view.document.querySelector('[role="dialog"]') ? buttons(view, label).at(-1) : undefined;

describe("Thread erasure", () => {
  const thread = { archived: true, executionPurpose: "customer", id: THREAD } as Thread;

  test("erase stays disabled until the phrase is typed, then erases that thread", async () => {
    await inRouter(<ThreadActions scope={scope} thread={thread} />, async (view) => {
      expect(buttons(view, "Archive")).toEqual([]);
      await view.click(buttons(view, "Erase")[0]);
      expect(confirmButton(view, "Erase thread")?.hasAttribute("disabled")).toBe(true);
      await typeInto(view, "confirmation", "erase");
      expect(confirmButton(view, "Erase thread")?.hasAttribute("disabled")).toBe(true);
      expect(calls).toEqual([]);
      await typeInto(view, "confirmation", "erase thread");
      await view.click(confirmButton(view, "Erase thread"));
      expect(calls).toEqual([{ data: { scope, threadId: THREAD }, fn: "eraseThread" }]);
    });
  });

  test("preview and evaluation threads offer neither archive nor erase", async () => {
    const preview = { ...thread, archived: false, executionPurpose: "preview" } as Thread;
    await inRouter(<ThreadActions scope={scope} thread={preview} />, async (view) => {
      expect(view.document.querySelectorAll("button").length).toBe(0);
    });
  });
});

describe("End-user erasure", () => {
  test("needs an end-user ID and the phrase, then erases in the chosen environment", async () => {
    await inRouter(
      <EndUserErasureSection organizationId={scope.organizationId} />,
      async (view) => {
        await view.click(buttons(view, "Erase an end user")[0]);
        await typeInto(view, "confirmation", "erase end user");
        expect(confirmButton(view, "Erase end user")?.hasAttribute("disabled")).toBe(true);
        await typeInto(view, "endUserId", "  customer-42 ");
        await view.click(confirmButton(view, "Erase end user"));
        expect(calls).toEqual([{ data: { endUserId: "customer-42", scope }, fn: "eraseEndUser" }]);
      },
    );
  });
});

describe("Observability unavailable", () => {
  function Offline(): ReactNode {
    throw new PlatformApiError("listObservabilityTraces", {
      code: "observability_unavailable",
      status: 503,
      title: "Observability unavailable",
    });
  }

  for (const install of ["managed", "self-hosted"] as const) {
    test(`a ${install} install shows its own message with a retry`, async () => {
      const edition: ConsoleEdition = { ...DEFAULT_CONSOLE_EDITION, install };
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await inRouter(
          <SectionBoundary resetKey="traces">
            <Offline />
          </SectionBoundary>,
          async (view) => {
            const text = view.document.body.textContent ?? "";
            expect(text).toContain("Observability is unavailable");
            expect(text).toContain(INSTALL_COPY[install].observabilityUnavailable);
            expect(text.includes("agent_observability_hot_enabled")).toBe(
              install === "self-hosted",
            );
            expect(buttons(view, "Try again")).toHaveLength(1);
          },
          { edition },
        );
      } finally {
        errors.mockRestore();
      }
    });
  }
});

describe("Artifact download", () => {
  const artifact = {
    artifactId: ARTIFACT,
    byteSize: 2048,
    contentType: "application/pdf",
    createdAt: AT,
    fileName: "report.pdf",
    name: "report",
    object: "artifact",
    status: "available",
    type: "file",
    updatedAt: AT,
    version: 1,
    visibility: "organization",
  } as Artifact;
  const owner = { kind: "run", runId: "01K000000000000000000000R1" } as const;

  test("Download mints a link for that file and hands the https URL to the page", async () => {
    await inRouter(
      <ArtifactList owner={owner} scope={scope} />,
      async (view) => {
        const page = view.document.defaultView;
        if (!page) throw new Error("withClient installs a window");
        const assigned: string[] = [];
        const location = { assign: (url: string) => assigned.push(url) };
        const proxy = new Proxy(page, {
          get: (target, key) => {
            if (key === "location") return location;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
        Reflect.set(globalThis, "window", proxy);
        try {
          expect(view.document.body.textContent).toContain("report.pdf");
          await view.click(buttons(view, "Download")[0]);
        } finally {
          if (saved) Object.defineProperty(globalThis, "window", saved);
        }
        expect(calls).toEqual([
          { data: { artifactId: ARTIFACT, scope }, fn: "createArtifactLink" },
        ]);
        expect(assigned).toEqual(["https://files.example.com/report.pdf?sig=1"]);
      },
      {
        seed: (client) =>
          client.setQueryData(artifactPagesQuery(scope, owner).queryKey, {
            pageParams: [undefined],
            pages: [{ items: [artifact] }],
          }),
      },
    );
  });
});
