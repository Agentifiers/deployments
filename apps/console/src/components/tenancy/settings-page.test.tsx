import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import * as mutations from "../../data/tenancy-settings-mutations.ts";
import { tenancyResourceQuery } from "../../data/tenancy-settings-queries.ts";
import { PlatformApiError } from "../../errors.ts";
import { needsWrite } from "../../server/expected-version.ts";
import type { TenancyRef, TenancyResource } from "../../tenancy/settings.ts";
import type { ClientView } from "@/components/ui/render-client";
import { buttons, renderWith, typeInto } from "../apps/app-fixtures.tsx";
import { SettingsPage } from "./settings-page.tsx";

const PROJECT: TenancyRef = {
  level: "project",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};

const OPENED: TenancyResource = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: PROJECT.projectId,
  name: "Checkout",
  slug: "checkout",
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 3,
};

/** What the API holds now: someone renamed it after the form opened. */
const STORED = { ...OPENED, name: "Checkout (renamed elsewhere)", version: 4 };

const sent: { readonly data: unknown; readonly fn: string }[] = [];

spyOn(mutations, "updateTenancyResourceFn").mockImplementation((async ({
  data,
}: {
  readonly data: { readonly body: Record<string, unknown>; readonly expectedVersion: number };
}) => {
  sent.push({ data, fn: "update" });
  needsWrite(
    "updateProject",
    "project",
    { values: { ...STORED }, version: STORED.version },
    data.body,
    data.expectedVersion,
  );
  return STORED;
}) as never);

spyOn(mutations, "archiveTenancyResourceFn").mockImplementation((async ({
  data,
}: {
  readonly data: unknown;
}) => {
  sent.push({ data, fn: "archive" });
  throw new PlatformApiError("archiveProject", {
    code: "insufficient_role",
    detail: "Archiving a project requires one of these organization roles: owner, admin.",
    requestId: "req-archive",
    status: 403,
    title: "Forbidden",
  });
}) as never);

afterAll(() => {
  mock.restore();
});

function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(tenancyResourceQuery(PROJECT).queryKey, OPENED);
  return queryClient;
}

const dialogText = (view: ClientView) =>
  view.document.querySelector('[role="dialog"]')?.textContent ?? "";

describe("tenancy settings page", () => {
  test("a rename from a stale form shows the version conflict", async () => {
    sent.length = 0;
    let shown = "";
    await renderWith(
      client(),
      <SettingsPage canArchive canEdit reference={PROJECT} />,
      async (view) => {
        await view.click(buttons(view, "Edit")[0]);
        await typeInto(view, "name", "Storefront");
        await view.click(buttons(view, "Save changes")[0]);
        shown = dialogText(view);
      },
    );
    expect(sent).toEqual([
      {
        data: {
          body: { name: "Storefront" },
          expectedVersion: 3,
          idempotencyKey: expect.any(String),
          ref: PROJECT,
        },
        fn: "update",
      },
    ]);
    expect(shown).toContain("Changed since you opened it");
    expect(shown).toContain("Someone changed this project after you opened the form.");
  });

  test("an archive the API refuses shows the refusal and keeps the dialog open", async () => {
    sent.length = 0;
    let shown = "";
    let stillOpen = false;
    await renderWith(
      client(),
      <SettingsPage canArchive canEdit reference={PROJECT} />,
      async (view) => {
        await view.click(buttons(view, "Archive project")[0]);
        const confirm = () =>
          buttons(view, "Archive project").find((node) => node.closest('[role="dialog"]'));
        const disabledBeforeTyping = confirm()?.matches(":disabled");
        await typeInto(view, "confirmation", "checkout");
        await view.click(confirm());
        shown = dialogText(view);
        stillOpen = disabledBeforeTyping === true && confirm() !== undefined;
      },
    );
    expect(sent).toEqual([
      { data: { idempotencyKey: expect.any(String), ref: PROJECT }, fn: "archive" },
    ]);
    expect(stillOpen).toBe(true);
    expect(shown).toContain("Your organization role does not permit this");
    expect(shown).toContain(
      "Archiving a project requires one of these organization roles: owner, admin.",
    );
    expect(shown).toContain("req-archive");
  });
});

describe("needsWrite", () => {
  const current = { values: { name: "Checkout", slug: "checkout" }, version: 4 };

  test("skips a change the resource already holds, so a retried rename that applied succeeds", () => {
    expect(needsWrite("updateProject", "project", current, { name: "Checkout" }, 3)).toBe(false);
  });

  test("writes a change made from the current version", () => {
    expect(needsWrite("updateProject", "project", current, { name: "Storefront" }, 4)).toBe(true);
  });
});
