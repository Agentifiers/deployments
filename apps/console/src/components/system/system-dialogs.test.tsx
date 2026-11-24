import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { withClient, type ClientView } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";
import * as mutations from "../../data/system-mutations.ts";
import type { SystemStanding } from "../../server/system-data.ts";
import { SetDataBoundaryDialog } from "./data-boundary-dialogs.tsx";
import { EntitlementsEditor } from "./entitlement-dialogs.tsx";
import { PlaceHoldDialog } from "./hold-dialogs.tsx";
import { SystemShell } from "./system-shell.tsx";

const ORG = "01K000000000000000000000G1";
const AT = "2026-10-09T12:00:00.000Z";

const sent: { readonly data: unknown; readonly fn: string }[] = [];
const recorded =
  (fn: string, result: () => unknown) =>
  async ({ data }: { readonly data: unknown }) => {
    sent.push({ data, fn });
    return result();
  };

const standing: SystemStanding = {
  defaults: {
    operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
    tenantLimits: {
      activeSandboxes: 1,
      apiRequestBurst: 40,
      apiRequestsPerSecond: 20,
      concurrentRuns: 2,
    },
  },
  effective: {
    features: { scim: false, sso: true },
    operatorFundedModelSpendCeiling: "unlimited",
    tenantLimits: {
      activeSandboxes: 1,
      apiRequestBurst: 40,
      apiRequestsPerSecond: 20,
      concurrentRuns: 8,
    },
  },
  grants: {
    operator: null,
    service: {
      entitlements: {
        features: { scim: false },
        operatorFundedModelSpendCeiling: "unlimited",
        tenantLimits: { concurrentRuns: 8 },
      },
      grantedAt: AT,
      grantedBy: { kind: "service", service: "billing" },
    },
  },
  holds: [],
  organizationId: ORG,
  state: "active",
  suspendedAt: null,
  version: 1,
} as unknown as SystemStanding;

spyOn(mutations, "placeHoldFn").mockImplementation(
  recorded("placeHoldFn", () => ({ changed: true, standing })) as never,
);
spyOn(mutations, "replaceEntitlementsFn").mockImplementation(
  recorded("replaceEntitlementsFn", () => ({ changed: true, standing })) as never,
);
spyOn(mutations, "setDataBoundaryFn").mockImplementation(
  recorded("setDataBoundaryFn", () => ({ changed: true, standing })) as never,
);
afterAll(() => {
  mock.restore();
});

/** Sets a controlled field by name the way React sees a user edit. */
async function typeInto(view: ClientView, name: string, text: string) {
  const field = view.document.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`input[name="${name}"], select[name="${name}"], textarea[name="${name}"]`);
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

describe("place hold form", () => {
  test("submits only with a valid key, a customer message, and the typed slug", async () => {
    const ready: (boolean | undefined)[] = [];
    await render(
      <PlaceHoldDialog
        confirmation="acme"
        existingKeys={[]}
        onClose={() => {}}
        organizationId={ORG}
      />,
      async (view) => {
        const enabled = () => button(view, "Place hold")?.matches(":disabled") === false;
        await typeInto(view, "key", "Bad Key");
        await typeInto(view, "customerMessage", "Contact support to restore access.");
        await typeInto(view, "confirmation", "acme");
        ready.push(enabled());
        await typeInto(view, "key", "fraud-review");
        await typeInto(view, "confirmation", "acm");
        ready.push(enabled());
        await typeInto(view, "confirmation", "acme");
        ready.push(enabled());
        await typeInto(view, "operatorNote", "Chargeback pattern on invoice 42");
        await view.click(button(view, "Place hold"));
      },
    );
    expect(ready).toEqual([false, false, true]);
    expect(sent).toEqual([
      {
        data: {
          body: {
            customerMessage: "Contact support to restore access.",
            operatorNote: "Chargeback pattern on invoice 42",
            reason: "manual",
          },
          holdKey: "fraud-review",
          organizationId: ORG,
        },
        fn: "placeHoldFn",
      },
    ]);
  });
});

describe("entitlements editor", () => {
  const previewRows = (view: ClientView) =>
    [
      ...view.document.querySelectorAll(
        '[aria-label="Effective entitlements after saving"] tbody tr',
      ),
    ].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));

  test("previews the merged effective values and saves only the fields it sets", async () => {
    let preview: (string | null)[][] = [];
    await render(
      <EntitlementsEditor onClose={() => {}} organizationId={ORG} standing={standing} />,
      async (view) => {
        await typeInto(view, "apiRequestsPerSecond", "60");
        await typeInto(view, "activeSandboxes", "0");
        await typeInto(view, "sso", "off");
        preview = previewRows(view);
        await view.click(button(view, "Save grant"));
      },
    );
    expect(preview).toEqual([
      ["Operator-funded model spend", "Unlimited", "Unlimited"],
      ["Single sign-on (SSO)", "On", "Off"],
      ["Directory sync (SCIM)", "Off", "Off"],
      ["Concurrent runs", "8", "8"],
      ["Active sandboxes", "1", "0"],
      ["API requests per second", "20", "60"],
      ["API request burst", "40", "60"],
    ]);
    expect(sent).toEqual([
      {
        data: {
          body: {
            features: { sso: false },
            tenantLimits: { activeSandboxes: 0, apiRequestsPerSecond: 60 },
          },
          organizationId: ORG,
        },
        fn: "replaceEntitlementsFn",
      },
    ]);
  });

  test("an out-of-range limit names its range and blocks saving", async () => {
    let problem: string | null | undefined;
    let disabled: boolean | undefined;
    await render(
      <EntitlementsEditor onClose={() => {}} organizationId={ORG} standing={standing} />,
      async (view) => {
        await typeInto(view, "concurrentRuns", "999");
        problem = view.document.querySelector('[data-slot="field-error"]')?.textContent;
        disabled = button(view, "Save grant")?.matches(":disabled");
      },
    );
    expect(problem).toBe("concurrentRuns must be an integer from 1 to 256.");
    expect(disabled).toBe(true);
  });
});

describe("set data boundary form", () => {
  test("submits the profile and the trimmed note, and needs a note to submit", async () => {
    const ready: (boolean | undefined)[] = [];
    let profiles: (string | null)[] = [];
    await render(
      <SetDataBoundaryDialog onClose={() => {}} organizationId={ORG} />,
      async (view) => {
        const enabled = () => button(view, "Set boundary")?.matches(":disabled") === false;
        profiles = [...view.document.querySelectorAll('select[name="profile"] option')].map(
          (option) => option.getAttribute("value"),
        );
        ready.push(enabled());
        await typeInto(view, "operatorNote", "   ");
        ready.push(enabled());
        await typeInto(view, "operatorNote", " BAA 2026-17 ");
        ready.push(enabled());
        await view.click(button(view, "Set boundary"));
      },
    );
    expect(profiles).toEqual(["phi"]);
    expect(ready).toEqual([false, false, true]);
    expect(sent).toEqual([
      {
        data: { body: { operatorNote: "BAA 2026-17", profile: "phi" }, organizationId: ORG },
        fn: "setDataBoundaryFn",
      },
    ]);
  });
});

describe("system shell", () => {
  const sidebar = async (platformAdministrator: boolean) => {
    const doc = await renderDocument(
      <SystemShell platformAdministrator={platformAdministrator}>
        <h1>Install</h1>
      </SystemShell>,
    );
    return {
      heading: doc.querySelector("h1")?.textContent,
      links: [...doc.querySelectorAll('[data-sidebar="menu-button"]')].map((link) =>
        link.textContent?.trim(),
      ),
    };
  };

  test("lists the system pages only for a platform administrator", async () => {
    expect(await sidebar(true)).toEqual({
      heading: "Install",
      links: [
        "Organizations",
        "Overview",
        "Deployments",
        "Health",
        "Model providers",
        "Organizations",
        "People",
        "Operator access",
      ],
    });
    expect(await sidebar(false)).toEqual({ heading: "System", links: ["Organizations"] });
  });
});
