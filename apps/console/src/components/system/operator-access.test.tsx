import { GetSystemOrganizationAccessResponse } from "@deployments-ai/api-contract/system";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Schema } from "effect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";
import * as mutations from "../../data/system-mutations.ts";
import type { SystemOrganizationAccess } from "../../server/system-data.ts";
import { AuditActor } from "../audit/audit-log.tsx";
import { OperatorAccessPanel } from "./operator-access.tsx";

const ORG = "01K000000000000000000000G1";
const ME = "01K000000000000000000000M1";
const GRANT = "01K000000000000000000000A1";

const decoded = Schema.decodeUnknownSync(GetSystemOrganizationAccessResponse)({
  access: {
    closedAt: null,
    expiresAt: "2026-11-03T13:00:00.000Z",
    grantId: GRANT,
    openedAt: "2026-11-03T12:00:00.000Z",
    organizationId: ORG,
    principalId: ME,
    reason: "Customer asked for help",
    status: "open",
    ticket: "SUP-7",
  },
  organization: { id: ORG, name: "Acme", slug: "acme", status: "disabled" },
});
const { organization } = decoded;
const openAccess = decoded.access!;

const sent: { readonly data: unknown; readonly fn: string }[] = [];
spyOn(mutations, "openOrganizationAccessFn").mockImplementation((async ({
  data,
}: {
  readonly data: unknown;
}) => {
  sent.push({ data, fn: "openOrganizationAccessFn" });
  return { access: openAccess, renewed: false };
}) as never);
afterAll(() => {
  mock.restore();
});

async function typeInto(view: ClientView, name: string, text: string) {
  const field = view.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `input[name="${name}"], textarea[name="${name}"]`,
  );
  const props = field
    ? Object.entries(field).find(([key]) => key.startsWith("__reactProps$"))?.[1]
    : undefined;
  if (!field || typeof props !== "object" || props === null || !("onChange" in props)) {
    throw new Error(`no controlled field named ${name}`);
  }
  const { onChange } = props as { readonly onChange: (event: unknown) => void };
  await act(async () => {
    field.value = text;
    onChange({ currentTarget: field, nativeEvent: new Event("input"), target: field });
  });
}

const button = (view: ClientView, text: string) =>
  [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);

const render = (ui: ReactNode, run: (view: ClientView) => Promise<void>) => {
  sent.length = 0;
  return withClient(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
    async (view) => {
      const window = view.document.defaultView;
      if (!window) throw new Error("withClient installs a window");
      Object.assign(window, { PointerEvent: window.MouseEvent });
      Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
      await run(view);
    },
  );
};

const panelText = async (props: SystemOrganizationAccess) => {
  const doc = await renderDocument(
    <QueryClientProvider client={new QueryClient()}>
      <OperatorAccessPanel {...props} />
    </QueryClientProvider>,
  );
  const panel = doc.querySelector('[aria-label="Operator access"]');
  return {
    buttons: [...(panel?.querySelectorAll("button") ?? [])].map((node) => ({
      disabled: node.hasAttribute("disabled"),
      text: node.textContent,
    })),
    status: panel?.querySelector('[data-slot="badge"]')?.textContent ?? null,
  };
};

describe("operator access panel", () => {
  test("offers to open access when none is open, and renew or close while it is", async () => {
    expect(await panelText({ access: null, organization })).toEqual({
      buttons: [{ disabled: false, text: "Open access…" }],
      status: "never opened",
    });
    expect(
      await panelText({
        access: { ...openAccess, closedAt: "2026-11-03T12:30:00.000Z", status: "closed" },
        organization,
      }),
    ).toEqual({ buttons: [{ disabled: false, text: "Open access…" }], status: "closed" });
    expect(await panelText({ access: openAccess, organization })).toEqual({
      buttons: [
        { disabled: false, text: "Renew…" },
        { disabled: false, text: "Close access…" },
      ],
      status: "open",
    });
  });

  test("cannot open access to an archived organization", async () => {
    expect(
      await panelText({ access: null, organization: { ...organization, status: "archived" } }),
    ).toEqual({ buttons: [{ disabled: true, text: "Open access…" }], status: "never opened" });
  });

  test("opening needs a reason and a duration in range, and sends the ticket", async () => {
    const ready: (boolean | undefined)[] = [];
    await render(
      <OperatorAccessPanel access={null} organization={organization} />,
      async (view) => {
        await view.click(button(view, "Open access…"));
        const enabled = () => button(view, "Open access")?.matches(":disabled") === false;
        ready.push(enabled());
        await typeInto(view, "reason", "Customer asked for help");
        await typeInto(view, "duration", "481");
        ready.push(enabled());
        await typeInto(view, "duration", "90");
        await typeInto(view, "ticket", " SUP-7 ");
        ready.push(enabled());
        await view.click(button(view, "Open access"));
      },
    );
    expect(ready).toEqual([false, false, true]);
    expect(sent).toEqual([
      {
        data: {
          body: { durationMinutes: 90, reason: "Customer asked for help", ticket: "SUP-7" },
          organizationId: ORG,
        },
        fn: "openOrganizationAccessFn",
      },
    ]);
  });
});

describe("audit actor", () => {
  test("marks a platform administrator acting under operator access", async () => {
    const actor = async (operatorAccessGrantId?: string) =>
      (
        await renderDocument(
          <AuditActor
            actor={{
              id: Schema.decodeUnknownSync(PublicId)(ME),
              type: "principal",
              ...(operatorAccessGrantId
                ? {
                    operatorAccessGrantId:
                      Schema.decodeUnknownSync(PublicId)(operatorAccessGrantId),
                  }
                : {}),
            }}
          />,
        )
      ).body.textContent;
    expect(await actor()).not.toContain("operator access");
    expect(await actor(GRANT)).toContain("platform administrator, operator access");
  });
});
