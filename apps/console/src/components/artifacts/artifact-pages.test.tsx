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
import { act, type ReactNode } from "react";
import { operationAccess } from "../../access.ts";
import type { ArtifactFilters } from "../../artifacts/filters.ts";
import * as artifactMutations from "../../data/artifact-mutations.ts";
import { artifactTextQuery } from "../../data/artifact-queries.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import * as threadMutations from "../../data/thread-mutations.ts";
import { artifactPagesQuery, artifactQuery } from "../../data/thread-queries.ts";
import { DEFAULT_CONSOLE_EDITION, type ConsoleRouterContext } from "../../edition.ts";
import type { Artifact, ArtifactText } from "../../server/artifact-data.ts";
import type { EnvironmentSummary, OrganizationShell } from "../../server/console-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { buttons, renderWith, typeInto } from "../apps/app-fixtures.tsx";
import { ArtifactBrowser } from "./artifact-browser.tsx";
import { ArtifactDetail } from "./artifact-detail.tsx";
import { UploadArtifactDialog } from "./upload-dialog.tsx";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
const AT = "2026-10-09T12:00:00.000Z";
const ARTIFACT = "01K000000000000000000000F1";
const RUN = "01K000000000000000000000R1";
const THREAD = "01K000000000000000000000T1";
const base = `/o/${scope.organizationId}/p/${scope.projectId}/e/${scope.environmentId}`;

function shellFor(role: "owner" | "viewer"): OrganizationShell {
  return {
    access: operationAccess({
      capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
      organizationRole: role,
    }),
    authorization: { capabilities: [], organizationRole: role },
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
    projects: [],
  };
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: ARTIFACT,
    byteSize: 2048,
    contentType: "text/csv",
    createdAt: AT,
    fileName: "orders.csv",
    name: "Orders",
    object: "artifact",
    runId: RUN,
    status: "available",
    threadId: THREAD,
    type: "report",
    updatedAt: AT,
    version: 1,
    visibility: "organization",
    ...overrides,
  } as Artifact;
}

const calls: { readonly data: unknown; readonly fn: string }[] = [];
spyOn(threadMutations, "createArtifactLinkFn").mockImplementation((({
  data,
}: {
  data: unknown;
}) => {
  calls.push({ data, fn: "createArtifactLink" });
  return Promise.resolve({ expiresAt: AT, url: "https://files.example.com/a?sig=1" });
}) as unknown as typeof threadMutations.createArtifactLinkFn);
spyOn(artifactMutations, "deleteArtifactFn").mockImplementation((({ data }: { data: unknown }) => {
  calls.push({ data, fn: "deleteArtifact" });
  return Promise.resolve(artifact({ status: "deleted" }));
}) as unknown as typeof artifactMutations.deleteArtifactFn);
spyOn(artifactMutations, "createArtifactUploadFn").mockImplementation((({
  data,
}: {
  data: unknown;
}) => {
  calls.push({ data, fn: "createArtifactUpload" });
  return Promise.resolve({
    artifactId: ARTIFACT,
    upload: {
      expiresAt: "2999-01-01T00:00:00.000Z",
      headers: { "content-length": "3", "x-amz-checksum-sha256": "digest" },
      url: "https://files.example.com/upload?sig=1",
    },
  });
}) as unknown as typeof artifactMutations.createArtifactUploadFn);
spyOn(artifactMutations, "completeArtifactUploadFn").mockImplementation((({
  data,
}: {
  data: unknown;
}) => {
  calls.push({ data, fn: "completeArtifactUpload" });
  return Promise.resolve(artifact());
}) as unknown as typeof artifactMutations.completeArtifactUploadFn);
afterEach(() => {
  calls.length = 0;
});
afterAll(() => {
  mock.restore();
});

interface Seed {
  readonly detail?: Artifact;
  readonly environment?: EnvironmentSummary["type"];
  readonly filters?: ArtifactFilters;
  readonly pages?: readonly { readonly items: readonly Artifact[]; readonly nextCursor?: string }[];
  readonly role?: "owner" | "viewer";
  readonly text?: ArtifactText;
}

async function inRouter(ui: ReactNode, run: (view: ClientView) => Promise<void>, seed: Seed = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(
    organizationShellQuery(scope.organizationId).queryKey,
    shellFor(seed.role ?? "owner"),
  );
  queryClient.setQueryData(agentDirectoryQuery(scope).queryKey, {
    definitions: [],
    deployments: [],
  });
  queryClient.setQueryData(environmentQuery(scope).queryKey, {
    type: seed.environment ?? "development",
  } as EnvironmentSummary);
  if (seed.pages) {
    queryClient.setQueryData(
      artifactPagesQuery(scope, { filters: seed.filters ?? {}, kind: "environment" }).queryKey,
      { pageParams: seed.pages.map(() => undefined), pages: [...seed.pages] },
    );
  }
  if (seed.detail) {
    queryClient.setQueryData(artifactQuery(scope, seed.detail.artifactId).queryKey, seed.detail);
    if (seed.text) {
      queryClient.setQueryData(
        artifactTextQuery(scope, seed.detail.artifactId).queryKey,
        seed.text,
      );
    }
  }
  const root = createRootRouteWithContext<ConsoleRouterContext>()({ component: () => ui });
  const router = createRouter({
    context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

const text = (view: ClientView) => view.document.body.textContent ?? "";
const hrefs = (view: ClientView) =>
  [...view.document.querySelectorAll("a")].map((link) => link.getAttribute("href"));

describe("Environment artifacts list", () => {
  const browse = (
    filters: ArtifactFilters = {},
    onFilter: (patch: unknown) => void = () => {},
    onUpload?: () => void,
  ) => <ArtifactBrowser filters={filters} onFilter={onFilter} onUpload={onUpload} scope={scope} />;

  test("lists artifacts with links to the artifact, its run, and its thread", async () => {
    await inRouter(
      browse(),
      async (view) => {
        expect(text(view)).toContain("Orders");
        expect(text(view)).toContain("text/csv");
        expect(hrefs(view)).toEqual(
          expect.arrayContaining([
            `${base}/artifacts/${ARTIFACT}`,
            `${base}/runs/${RUN}`,
            `${base}/threads/${THREAD}`,
          ]),
        );
        expect(buttons(view, "Load more")).toHaveLength(0);
      },
      { pages: [{ items: [artifact()] }] },
    );
  });

  test("offers more pages while the server holds a cursor", async () => {
    await inRouter(
      browse(),
      async (view) => {
        expect(text(view)).toContain("Orders");
        expect(buttons(view, "Load more")).toHaveLength(1);
      },
      { pages: [{ items: [artifact()], nextCursor: "next" }] },
    );
  });

  test("an empty environment explains where artifacts come from and offers the page's upload", async () => {
    let uploads = 0;
    await inRouter(
      browse(
        {},
        () => {},
        () => (uploads += 1),
      ),
      async (view) => {
        expect(text(view)).toContain("No artifacts yet");
        await view.click(buttons(view, "Upload a file")[0]);
        expect(uploads).toBe(1);
      },
      { pages: [{ items: [] }] },
    );
  });

  test("a filtered list with no match offers to clear the filters", async () => {
    const patches: unknown[] = [];
    await inRouter(
      browse({ contentType: "image/*" }, (patch) => patches.push(patch)),
      async (view) => {
        expect(text(view)).toContain("No matching artifacts");
        await view.click(buttons(view, "Clear filters")[0]);
        expect(patches).toEqual([
          {
            contentType: undefined,
            createdAfter: undefined,
            createdBefore: undefined,
            runId: undefined,
            threadId: undefined,
            type: undefined,
          },
        ]);
      },
      { filters: { contentType: "image/*" }, pages: [{ items: [] }] },
    );
  });

  test("without an upload action an empty list offers none", async () => {
    await inRouter(
      browse(),
      async (view) => {
        expect(buttons(view, "Upload a file")).toHaveLength(0);
      },
      { pages: [{ items: [] }], role: "viewer" },
    );
  });
});

describe("Artifact detail", () => {
  const detail = (id = ARTIFACT) => <ArtifactDetail artifactId={id} scope={scope} />;

  test("shows metadata JSON, retention, and a capped text preview", async () => {
    const shown = artifact({
      byteSize: 1024 * 1024,
      metadataJson: JSON.stringify({ source: "nightly" }, null, 2),
      retentionExpiresAt: "2026-12-01T00:00:00.000Z",
    });
    await inRouter(
      detail(),
      async (view) => {
        expect(text(view)).toContain('"source": "nightly"');
        expect(text(view)).toContain("id,total");
        expect(text(view)).toContain("Shows the first 256.0 KiB of 1.0 MiB");
        expect(text(view)).not.toContain("Until it, its thread");
        expect(hrefs(view)).toEqual(
          expect.arrayContaining([`${base}/runs/${RUN}`, `${base}/threads/${THREAD}`]),
        );
      },
      { detail: shown, text: { kind: "text", text: "id,total\n1,20", truncated: true } },
    );
  });

  test("never renders HTML or SVG inline and offers the download instead", async () => {
    for (const contentType of ["text/html", "image/svg+xml"]) {
      await inRouter(
        detail(),
        async (view) => {
          expect(text(view)).toContain("a browser can run code from it");
          expect(view.document.querySelector("iframe, img, object, embed")).toBeNull();
          expect(calls).toEqual([]);
          expect(buttons(view, "Download")).toHaveLength(1);
        },
        { detail: artifact({ contentType }) },
      );
    }
  });

  test("shows an image through a fresh signed link in an img element", async () => {
    await inRouter(
      detail(),
      async (view) => {
        const image = view.document.querySelector("img");
        expect(image?.getAttribute("src")).toBe("https://files.example.com/a?sig=1");
        expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(calls).toEqual([
          { data: { artifactId: ARTIFACT, purpose: "preview", scope }, fn: "createArtifactLink" },
        ]);
      },
      { detail: artifact({ contentType: "image/png" }) },
    );
  });

  test("says when a text file holds binary bytes", async () => {
    await inRouter(
      detail(),
      async (view) => {
        expect(text(view)).toContain("bytes that are not text");
      },
      { detail: artifact(), text: { kind: "binary" } },
    );
  });

  test("a pending artifact has no preview or download yet", async () => {
    await inRouter(
      detail(),
      async (view) => {
        expect(text(view)).toContain("no stored bytes yet");
        expect(buttons(view, "Download")[0]?.hasAttribute("disabled")).toBe(true);
        expect(buttons(view, "Copy link")).toHaveLength(0);
      },
      { detail: artifact({ status: "pending" }) },
    );
  });

  test("delete in production needs the phrase, then deletes that artifact", async () => {
    await inRouter(
      detail(),
      async (view) => {
        await view.click(buttons(view, "Delete")[0]);
        const confirm = () => buttons(view, "Delete artifact").at(-1);
        expect(confirm()?.hasAttribute("disabled")).toBe(true);
        await typeInto(view, "confirmation", "delete");
        await view.click(confirm());
        expect(calls).toEqual([{ data: { artifactId: ARTIFACT, scope }, fn: "deleteArtifact" }]);
      },
      {
        detail: artifact(),
        environment: "production",
        text: { kind: "text", text: "a", truncated: false },
      },
    );
  });

  test("a viewer sees the artifact without retention or delete", async () => {
    await inRouter(
      detail(),
      async (view) => {
        expect(text(view)).toContain("Orders");
        expect(buttons(view, "Delete")).toHaveLength(0);
        expect(buttons(view, "Retention")).toHaveLength(0);
      },
      { detail: artifact(), role: "viewer", text: { kind: "text", text: "a", truncated: false } },
    );
  });

  test("a usable input file offers to start a run", async () => {
    await inRouter(
      detail(),
      async (view) => {
        expect(buttons(view, "Start a run with this file")).toHaveLength(1);
      },
      {
        detail: artifact({
          contentType: "application/pdf",
          input: { kind: "document", mediaType: "application/pdf", summary: "Orders" },
          type: "input",
          visibility: "private",
        }),
      },
    );
  });
});

/** Records the PUT the dialog sends and answers it with `status` and `body`. */
function fakeXhr(window: Window, answer: { readonly body: string; readonly status: number }) {
  const sent: { headers: Record<string, string>; method: string; url: string }[] = [];
  const { Event: DomEvent, EventTarget: DomEventTarget } = window as unknown as typeof globalThis;
  class FakeXhr extends DomEventTarget {
    readonly upload = new DomEventTarget();
    responseText = "";
    status = 0;
    private request = { headers: {} as Record<string, string>, method: "", url: "" };
    open(method: string, url: string) {
      this.request = { headers: {}, method, url };
    }
    setRequestHeader(name: string, value: string) {
      this.request.headers[name] = value;
    }
    send() {
      sent.push(this.request);
      setTimeout(() => {
        this.upload.dispatchEvent(Object.assign(new DomEvent("progress"), { loaded: 3 }));
        this.status = answer.status;
        this.responseText = answer.body;
        this.dispatchEvent(new DomEvent("load"));
      }, 0);
    }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  Reflect.set(globalThis, "XMLHttpRequest", FakeXhr);
  Reflect.set(window, "XMLHttpRequest", FakeXhr);
  return {
    restore: () => {
      if (saved) Object.defineProperty(globalThis, "XMLHttpRequest", saved);
      else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
    },
    sent,
  };
}

async function chooseFile(view: ClientView, file: File) {
  const input = view.document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

describe("Upload dialog", () => {
  const dialog = <UploadArtifactDialog onClose={() => {}} open scope={scope} />;

  test("hashes the file, sends it to the signed URL, then completes the upload", async () => {
    await inRouter(dialog, async (view) => {
      const xhr = fakeXhr(view.document.defaultView!, { body: "", status: 200 });
      try {
        await chooseFile(view, new File(["abc"], "notes.csv", { type: "text/csv" }));
        expect(view.document.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
          "notes",
        );
        await view.click(buttons(view, "Upload").at(-1));
        await settle();
        expect(xhr.sent).toEqual([
          {
            headers: { "x-amz-checksum-sha256": "digest" },
            method: "PUT",
            url: "https://files.example.com/upload?sig=1",
          },
        ]);
      } finally {
        xhr.restore();
      }
      expect(calls).toEqual([
        {
          data: {
            request: {
              byteSize: 3,
              contentType: "text/csv",
              fileName: "notes.csv",
              name: "notes",
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
              type: "file",
              visibility: "organization",
            },
            scope,
          },
          fn: "createArtifactUpload",
        },
        { data: { artifactId: ARTIFACT, scope }, fn: "completeArtifactUpload" },
      ]);
    });
  });

  test("explains an expired upload link and does not complete", async () => {
    await inRouter(dialog, async (view) => {
      const xhr = fakeXhr(view.document.defaultView!, {
        body: "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>",
        status: 403,
      });
      try {
        await chooseFile(view, new File(["abc"], "notes.txt", { type: "text/plain" }));
        await view.click(buttons(view, "Upload").at(-1));
        await settle();
      } finally {
        xhr.restore();
      }
      expect(text(view)).toContain("The upload link expired before the file arrived");
      expect(buttons(view, "Upload again")).toHaveLength(1);
      expect(calls.map((call) => call.fn)).toEqual(["createArtifactUpload"]);
    });
  });
});
