import { PublicId } from "@deployments-ai/api-contract/primitives";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { act } from "react";
import { withClient, type ClientView } from "@/components/ui/render-client";
import * as mutations from "../../data/governance-mutations.ts";
import { egressAllowlistQuery } from "../../data/governance-queries.ts";
import type { EgressAllowlist } from "../../server/governance-data.ts";
import { EgressAllowlistSection } from "./egress-allowlist-section.tsx";

const ORG = "01K000000000000000000000G1";
const AT = "2026-11-14T09:30:00.000Z";

const saved: EgressAllowlist = {
  entries: [{ note: "Claims clearinghouse", origin: "https://claims.example.com" }],
  organizationId: Schema.decodeUnknownSync(PublicId)(ORG),
  updatedAt: AT,
  updatedByPrincipalId: Schema.decodeUnknownSync(PublicId)("01K000000000000000000000P1"),
  version: 1,
};

const sent: unknown[] = [];
spyOn(mutations, "replaceEgressAllowlistFn").mockImplementation((async ({
  data,
}: {
  readonly data: { readonly body: { readonly entries: EgressAllowlist["entries"] } };
}) => {
  sent.push(data);
  return {
    allowlist: { ...saved, entries: data.body.entries, version: saved.version + 1 },
    changed: true,
  };
}) as never);
afterAll(() => {
  mock.restore();
});

async function typeInto(view: ClientView, name: string, text: string) {
  const input = view.document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  const props = input
    ? Object.entries(input).find(([key]) => key.startsWith("__reactProps$"))?.[1]
    : undefined;
  if (!input || typeof props !== "object" || props === null || !("onChange" in props)) {
    throw new Error(`no controlled input named ${name}`);
  }
  const { onChange } = props as { readonly onChange: (event: unknown) => void };
  await act(async () => {
    input.value = text;
    onChange({ currentTarget: input, nativeEvent: new Event("input"), target: input });
  });
}

const button = (view: ClientView, label: string) =>
  [...view.document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );

const origins = (view: ClientView) =>
  [...view.document.querySelectorAll('[aria-label="Allowed origins"] tbody tr')].map((row) =>
    [...row.querySelectorAll("td")].slice(0, 2).map((cell) => cell.textContent),
  );

const errors = (view: ClientView) =>
  [...view.document.querySelectorAll("[data-slot=field-error]")].map((node) => node.textContent);

async function render(canEdit: boolean, run: (view: ClientView) => Promise<void>) {
  sent.length = 0;
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(egressAllowlistQuery(ORG).queryKey, saved);
  await withClient(
    <QueryClientProvider client={queryClient}>
      <EgressAllowlistSection canEdit={canEdit} organizationId={ORG} />
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

describe("egress allowlist section", () => {
  test("validates an origin, adds and removes rows, and saves the whole list", async () => {
    const seen: unknown[] = [];
    await render(true, async (view) => {
      seen.push(button(view, "Save allowlist")?.matches(":disabled"));
      await typeInto(view, "origin", "http://labs.example.org");
      seen.push(errors(view));
      await typeInto(view, "origin", "https://labs.example.org/results");
      seen.push(errors(view));
      await typeInto(view, "origin", "https://*.example.org");
      seen.push(errors(view));
      await typeInto(view, "origin", "https://claims.example.com");
      seen.push(errors(view));
      await typeInto(view, "origin", "https://labs.example.org");
      await typeInto(view, "note", "Lab results portal");
      seen.push(errors(view));
      await view.click(button(view, "Add origin"));
      await view.click(button(view, "Remove https://claims.example.com"));
      seen.push(origins(view));
      seen.push(button(view, "Save allowlist")?.matches(":disabled"));
      await view.click(button(view, "Save allowlist"));
      const dialog = view.document.querySelector("[role=dialog]");
      seen.push([...(dialog?.querySelectorAll("li") ?? [])].map((item) => item.textContent));
      const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (node) => node.textContent === "Save allowlist",
      );
      await view.click(confirm);
    });

    expect(seen).toEqual([
      true,
      ["Use https. Plain http is not allowed."],
      ["Enter only the origin, without a path, query, or fragment."],
      ["Wildcards are not allowed. List each origin."],
      ["https://claims.example.com is already listed."],
      [],
      [["https://labs.example.org", "Lab results portal"]],
      false,
      ["Add https://labs.example.org", "Remove https://claims.example.com"],
    ]);
    expect(sent).toEqual([
      {
        body: { entries: [{ note: "Lab results portal", origin: "https://labs.example.org" }] },
        idempotencyKey: expect.any(String),
        scope: { organizationId: ORG },
      },
    ]);
  });

  test("a member reads the list without add, remove, or save", async () => {
    await render(false, async (view) => {
      expect(origins(view)).toEqual([["https://claims.example.com", "Claims clearinghouse"]]);
      expect(view.document.querySelector('input[name="origin"]')).toBeNull();
      expect(button(view, "Save allowlist")).toBeUndefined();
      expect(button(view, "Remove https://claims.example.com")).toBeUndefined();
      expect(view.document.body.textContent).toContain(
        "Only organization owners and admins can change the allowlist.",
      );
    });
    expect(sent).toEqual([]);
  });
});
