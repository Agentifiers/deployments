import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  AgentDefinitionResponse,
  AgentReleaseSummaryResponse,
} from "@deployments-ai/api-contract/agents";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { act, type ReactNode } from "react";
import { MANIFEST_TEMPLATE } from "../../agents/manifest-draft.ts";
import * as agentMutations from "../../data/agent-mutations.ts";
import { workspacesQuery } from "../../data/connection-queries.ts";
import * as releaseMutations from "../../data/release-mutations.ts";
import { PlatformApiError } from "../../errors.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { ArchiveAgentSection, ArchiveReleaseDialog } from "./archive-dialogs.tsx";
import { CreateAgentDefinitionDialog } from "./create-agent-dialog.tsx";
import { DraftEditor } from "./draft-editor.tsx";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
const AT = "2026-10-09T12:00:00.000Z";
const DEFINITION = "01K000000000000000000000AD";
const RELEASE = "01K000000000000000000000R1";

/** A saved draft: the new-agent template once its instructions are written. */
const DRAFT = {
  ...MANIFEST_TEMPLATE,
  spec: { ...MANIFEST_TEMPLATE.spec, instructions: "Answer support questions." },
};
const definition = Schema.decodeUnknownSync(AgentDefinitionResponse)({
  ...scope,
  createdAt: AT,
  draft: DRAFT,
  id: DEFINITION,
  name: "New agent",
  slug: "new-agent",
  status: "active",
  updatedAt: AT,
  version: 3,
});
const release = Schema.decodeUnknownSync(AgentReleaseSummaryResponse)({
  ...scope,
  agentDefinitionId: DEFINITION,
  contentHash: `sha256:${"a".repeat(64)}`,
  createdAt: AT,
  createdByPrincipalId: "01K000000000000000000000P1",
  id: RELEASE,
  releaseNumber: 2,
  status: "active",
  version: 4,
});
const agent: AgentDetail = { definition, deployments: [], releases: [release] };
const environment = { type: "development" } as EnvironmentSummary;

const sent: { readonly fn: string; readonly data: unknown }[] = [];
let answer: () => Promise<unknown> = () => Promise.reject(new Error("unset"));
const recorder =
  (fn: string) =>
  ({ data }: { readonly data: unknown }) => {
    sent.push({ data, fn });
    return answer();
  };
spyOn(agentMutations, "updateAgentDefinitionFn").mockImplementation(
  recorder("updateAgentDefinition") as unknown as typeof agentMutations.updateAgentDefinitionFn,
);
spyOn(agentMutations, "createAgentDefinitionFn").mockImplementation(
  recorder("createAgentDefinition") as unknown as typeof agentMutations.createAgentDefinitionFn,
);
spyOn(releaseMutations, "archiveAgentReleaseFn").mockImplementation(
  recorder("archiveAgentRelease") as unknown as typeof releaseMutations.archiveAgentReleaseFn,
);
afterEach(() => {
  sent.length = 0;
});
spyOn(agentMutations, "archiveAgentDefinitionFn").mockImplementation(
  recorder("archiveAgentDefinition") as unknown as typeof agentMutations.archiveAgentDefinitionFn,
);
afterAll(() => {
  mock.restore();
});

function render(
  ui: ReactNode,
  run: (view: ClientView) => Promise<void>,
  queryClient = new QueryClient(),
) {
  return withClient(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    async (view) => {
      const window = view.document.defaultView;
      if (!window) throw new Error("withClient installs a window");
      Object.assign(window, { PointerEvent: window.MouseEvent });
      Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
      await run(view);
    },
  );
}

/** Sets a controlled field's value through its React onChange (jsdom input events miss it). */
async function type(view: ClientView, name: string, text: string) {
  const field = view.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[name="${name}"]`,
  );
  const props = field
    ? Object.entries(field).find(([key]) => key.startsWith("__reactProps$"))?.[1]
    : undefined;
  const onChange = (props as { onChange?: unknown } | undefined)?.onChange;
  if (!field || typeof onChange !== "function") throw new Error(`no controlled field ${name}`);
  await act(async () => {
    field.value = text;
    onChange({ currentTarget: field, nativeEvent: new Event("input"), target: field });
  });
}

const buttons = (view: ClientView, label: string) =>
  [...view.document.querySelectorAll("button")].filter(
    (node) => node.textContent?.trim() === label,
  );

describe("DraftEditor", () => {
  test("a schema error shows at its field and blocks saving", async () => {
    await render(
      <DraftEditor
        agent={agent}
        environment={environment}
        onRefresh={async () => {}}
        scope={scope}
      />,
      async (view) => {
        await type(view, "spec.instructions", "   ");
        const field = view.document
          .querySelector('[name="spec.instructions"]')
          ?.closest("[data-slot=field]");
        expect(field?.querySelector("[data-slot=field-error]")?.textContent).toBe(
          "Agent instructions must not be empty.",
        );
        expect(
          view.document.querySelector('[aria-label="Manifest problems"]')?.textContent,
        ).toContain("spec.instructions");
        expect(buttons(view, "Save draft")[0]?.hasAttribute("disabled")).toBe(true);
        await view.click(buttons(view, "Save draft")[0]);
        expect(view.document.querySelector('[role="dialog"]')).toBeNull();
        expect(sent).toEqual([]);
      },
    );
  });

  test("a save sends the whole manifest at the loaded version", async () => {
    answer = () => Promise.resolve({ ...definition, version: 4 });
    await render(
      <DraftEditor
        agent={agent}
        environment={environment}
        onRefresh={async () => {}}
        scope={scope}
      />,
      async (view) => {
        await type(view, "spec.instructions", "Answer briefly.");
        await view.click(buttons(view, "Save draft")[0]);
        await view.click(buttons(view, "Save draft").at(-1));
        expect(sent).toEqual([
          {
            data: expect.objectContaining({
              body: {
                expectedVersion: 3,
                manifest: { ...DRAFT, spec: { ...DRAFT.spec, instructions: "Answer briefly." } },
              },
              definitionId: DEFINITION,
            }),
            fn: "updateAgentDefinition",
          },
        ]);
      },
    );
  });

  test("a version conflict offers to reload the latest draft", async () => {
    answer = () =>
      Promise.reject(
        new PlatformApiError("updateAgentDefinition", {
          code: "version_conflict",
          detail: "The resource version has changed.",
          status: 409,
          title: "Conflict",
        }),
      );
    let refreshed = 0;
    await render(
      <DraftEditor
        agent={agent}
        environment={environment}
        onRefresh={async () => {
          refreshed += 1;
        }}
        scope={scope}
      />,
      async (view) => {
        await type(view, "spec.instructions", "Answer briefly.");
        await view.click(buttons(view, "Save draft")[0]);
        await view.click(buttons(view, "Save draft").at(-1));
        const dialog = view.document.querySelector('[role="dialog"]');
        expect(dialog?.textContent).toContain("The draft changed after you loaded it");
        await view.click(buttons(view, "Reload the draft")[0]);
        expect(refreshed).toBe(1);
        expect(view.document.querySelector('[role="dialog"]')).toBeNull();
        expect(
          view.document.querySelector<HTMLTextAreaElement>('[name="spec.instructions"]')?.value,
        ).toBe(DRAFT.spec.instructions);
      },
    );
  });
});

describe("CreateAgentDefinitionDialog", () => {
  const value = (view: ClientView, name: string) =>
    view.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)?.value;

  test("starts with empty instructions, blocks creating until they are written, and derives the key from the name", async () => {
    answer = () => Promise.resolve(definition);
    await render(
      <CreateAgentDefinitionDialog
        canListWorkspaces={false}
        environmentType="production"
        onClose={() => {}}
        scope={scope}
      />,
      async (view) => {
        const create = () => buttons(view, "Create agent").at(-1);
        const steps: unknown[] = [
          value(view, "spec.instructions"),
          view.document.querySelector('[aria-label="Manifest problems"]'),
          view.document.querySelector('input[name="confirmation"]') !== null,
          create()?.hasAttribute("disabled"),
        ];
        await type(view, "metadata.name", "Billing Helper");
        steps.push(value(view, "metadata.key"));
        await type(view, "metadata.key", "billing");
        await type(view, "metadata.name", "Billing Helper 2");
        steps.push(value(view, "metadata.key"));
        await type(view, "spec.instructions", "Answer billing questions.");
        steps.push(create()?.hasAttribute("disabled"));
        await view.click(create());
        expect(steps).toEqual(["", null, false, true, "billing-helper", "billing", false]);
        expect(sent).toEqual([
          {
            data: expect.objectContaining({
              body: {
                manifest: {
                  ...MANIFEST_TEMPLATE,
                  metadata: {
                    ...MANIFEST_TEMPLATE.metadata,
                    key: "billing",
                    name: "Billing Helper 2",
                  },
                  spec: { ...MANIFEST_TEMPLATE.spec, instructions: "Answer billing questions." },
                },
              },
            }),
            fn: "createAgentDefinition",
          },
        ]);
      },
    );
  });

  test("Escape on a changed form asks before discarding it", async () => {
    await render(
      <CreateAgentDefinitionDialog
        canListWorkspaces={false}
        environmentType="development"
        onClose={() => {}}
        scope={scope}
      />,
      async (view) => {
        await type(view, "metadata.name", "Draft");
        await view.press("Escape");
        const asked = view.document.body.textContent?.includes("Discard changes?");
        await view.click(buttons(view, "Keep editing")[0]);
        expect([asked, value(view, "metadata.name")]).toEqual([true, "Draft"]);
      },
    );
  });

  test("hides the workspace choice when the environment has no workspaces", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    queryClient.setQueryData(workspacesQuery(scope).queryKey, []);
    await render(
      <CreateAgentDefinitionDialog
        canListWorkspaces
        environmentType="development"
        onClose={() => {}}
        scope={scope}
      />,
      async (view) => {
        expect(view.document.querySelector('[name="workspaceId"]')).toBeNull();
      },
      queryClient,
    );
  });
});

describe("ArchiveReleaseDialog", () => {
  test("archives the release at its version only after the typed confirmation", async () => {
    answer = () => Promise.resolve({ ...release, status: "archived", version: 5 });
    await render(
      <ArchiveReleaseDialog
        agent={agent}
        environment={environment}
        onClose={() => {}}
        release={release}
        scope={scope}
      />,
      async (view) => {
        const confirm = () => buttons(view, "Archive release")[0];
        expect(confirm()?.hasAttribute("disabled")).toBe(true);
        await type(view, "confirmation", "#2");
        await view.click(confirm());
        expect(sent).toEqual([
          {
            data: expect.objectContaining({
              body: { expectedVersion: 4 },
              releaseId: RELEASE,
            }),
            fn: "archiveAgentRelease",
          },
        ]);
      },
    );
  });
});

describe("ArchiveAgentSection", () => {
  test("archives the definition at its version only after typing its slug", async () => {
    answer = () => Promise.resolve({ ...definition, status: "archived", version: 4 });
    await render(
      <ArchiveAgentSection agent={agent} environment={environment} scope={scope} />,
      async (view) => {
        await view.click(buttons(view, "Archive agent")[0]);
        const confirm = () => buttons(view, "Archive agent").at(-1);
        expect(confirm()?.hasAttribute("disabled")).toBe(true);
        await type(view, "confirmation", "new-agent");
        await view.click(confirm());
        expect(sent).toEqual([
          {
            data: expect.objectContaining({
              body: { expectedVersion: 3 },
              definitionId: DEFINITION,
            }),
            fn: "archiveAgentDefinition",
          },
        ]);
      },
    );
  });
});
