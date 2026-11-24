import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { AccountProfile, AccountSecurity } from "../../account/account-security.ts";
import * as mutations from "../../data/account-mutations.ts";
import {
  accountProfileQuery,
  accountSecurityQuery,
  accountSessionsQuery,
} from "../../data/account-queries.ts";
import { DEFAULT_CONSOLE_EDITION, type ConsoleRouterContext } from "../../edition.ts";
import { Route as AccountRoute } from "../../routes/account.tsx";
import type { ClientView } from "@/components/ui/render-client";
import { buttons, renderWith, typeInto } from "../apps/app-fixtures.tsx";

const ORG = "01K000000000000000000000G1";
const sent: [string, unknown][] = [];
function stub(name: keyof typeof mutations, result: unknown) {
  const record = (input?: { readonly data?: unknown }) => {
    sent.push([name, input?.data]);
    return Promise.resolve(result);
  };
  spyOn(mutations, name).mockImplementation(record as never);
}
stub("requestEmailChangeFn", { email: "ada@new.example", expiresAt: "2026-10-09T13:00:00.000Z" });
stub("cancelEmailChangeFn", {});
stub("deleteAccountFn", {});
afterAll(() => {
  mock.restore();
});
beforeEach(() => {
  sent.length = 0;
});

const allowed: AccountProfile = {
  deletion: { kind: "allowed", leaves: [{ organizationId: ORG, organizationName: "Acme" }] },
  email: "ada@example.com",
  emailChange: { kind: "available" },
};
const off: AccountSecurity = { mfa: { state: "off" }, passwordSignIn: true };
const on: AccountSecurity = {
  mfa: { activatedAt: "2026-10-01T00:00:00.000Z", recoveryCodesRemaining: 9, state: "on" },
  passwordSignIn: true,
};

async function renderAccount(
  profile: AccountProfile,
  security: AccountSecurity,
  run: (view: ClientView) => Promise<void>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(accountSecurityQuery().queryKey, security);
  queryClient.setQueryData(accountProfileQuery().queryKey, profile);
  queryClient.setQueryData(accountSessionsQuery().queryKey, {
    pageParams: [undefined],
    pages: [{ items: [] }],
  });
  const root = createRootRouteWithContext<ConsoleRouterContext>()();
  const { component, loader } = AccountRoute.options;
  if (!component || !loader) throw new Error("the account route renders and loads");
  const account = createRoute({ component, getParentRoute: () => root, loader, path: "/account" });
  const router = createRouter({
    context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
    history: createMemoryHistory({ initialEntries: ["/account"] }),
    routeTree: root.addChildren([account]),
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

const card = (view: ClientView, title: string) =>
  [...view.document.querySelectorAll("[data-slot=card]")].find(
    (node) => node.querySelector("[data-slot=card-title]")?.textContent === title,
  );
const disabled = (view: ClientView, label: string) =>
  buttons(view, label).at(-1)?.hasAttribute("disabled");
const dialogTitle = (view: ClientView) =>
  view.document.querySelector("[role=dialog] h2")?.textContent;

/** Records form posts by their id instead of letting jsdom navigate. */
function posts(view: ClientView) {
  const submitted: string[] = [];
  view.document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    const action = form.getAttribute("action");
    if (action === null) return;
    event.preventDefault();
    submitted.push(`${form.id} ${action}`);
  });
  return submitted;
}

describe("account email", () => {
  test("changing the email with two-factor on needs the password, a code, and a new address", async () => {
    await renderAccount(allowed, on, async (view) => {
      await view.click(buttons(view, "Change email")[0]);
      const gates: unknown[] = [dialogTitle(view), disabled(view, "Send confirmation link")];
      await typeInto(view, "newEmail", "ADA@example.com");
      await typeInto(view, "password", "correct horse battery staple");
      await typeInto(view, "code", "123456");
      gates.push(disabled(view, "Send confirmation link"));
      await typeInto(view, "newEmail", "ada@new.example");
      gates.push(disabled(view, "Send confirmation link"));
      await view.click(buttons(view, "Send confirmation link").at(-1));

      expect({ gates, sent }).toEqual({
        gates: ["Change email", true, true, false],
        sent: [
          [
            "requestEmailChangeFn",
            {
              code: "123456",
              newEmail: "ada@new.example",
              password: "correct horse battery staple",
            },
          ],
        ],
      });
    });
  });

  test("a pending change shows where the link went and can be cancelled", async () => {
    const pending = {
      ...allowed,
      pendingEmail: { email: "ada@new.example", expiresAt: "2026-10-09T13:00:00.000Z" },
    };
    await renderAccount(pending, off, async (view) => {
      const text = card(view, "Email")?.textContent;
      await view.click(buttons(view, "Cancel change")[0]);
      await view.click(buttons(view, "Cancel change").at(-1));

      expect(text).toContain("Waiting for you to open the link sent to ada@new.example");
      expect(sent).toEqual([["cancelEmailChangeFn", undefined]]);
    });
  });

  test("an address an organization manages names who changes it and offers no button", async () => {
    const managed: AccountProfile = {
      ...allowed,
      emailChange: {
        kind: "managed",
        managedBy: "directory",
        organizationId: ORG,
        organizationName: "Acme",
      },
    };
    await renderAccount(managed, off, async (view) => {
      expect({
        button: buttons(view, "Change email").length,
        text: card(view, "Email")?.querySelector("[data-slot=card-description]")?.textContent,
      }).toEqual({
        button: 0,
        text: "Acme's directory (SCIM) manages this address. Ask that organization's administrators to change it.",
      });
    });
  });

  test("a recent or reported change holds the address and says which", async () => {
    for (const [reason, text] of [
      ["changed", "Your email changed recently."],
      ["reported", "was reported as one you did not make."],
    ] as const) {
      const held: AccountProfile = {
        ...allowed,
        emailChange: { kind: "held", reason, until: "2026-10-16T12:00:00.000Z" },
      };
      await renderAccount(held, off, async (view) => {
        expect(buttons(view, "Change email")).toHaveLength(0);
        expect(card(view, "Email")?.textContent).toContain(text);
      });
    }
  });
});

describe("account deletion", () => {
  test("explains what happens, needs the password and the typed phrase, then signs out", async () => {
    await renderAccount(allowed, off, async (view) => {
      const submitted = posts(view);
      const effects = card(view, "Delete account")?.querySelectorAll("li").length;
      await view.click(buttons(view, "Delete account")[0]);
      const gates: unknown[] = [
        dialogTitle(view),
        view.document.querySelector("[role=dialog]")?.textContent?.includes("You leave Acme."),
        disabled(view, "Delete account"),
      ];
      await typeInto(view, "password", "correct horse battery staple");
      gates.push(disabled(view, "Delete account"));
      await typeInto(view, "confirmation", "delete my account");
      gates.push(disabled(view, "Delete account"));
      await view.click(buttons(view, "Delete account").at(-1));

      expect({ effects, gates, sent, submitted }).toEqual({
        effects: 4,
        gates: ["Delete your account", true, true, true, false],
        sent: [["deleteAccountFn", { password: "correct horse battery staple" }]],
        submitted: ["account-deleted-sign-out /auth/logout"],
      });
    });
  });

  test("with two-factor on, deletion also needs a code", async () => {
    await renderAccount(allowed, on, async (view) => {
      await view.click(buttons(view, "Delete account")[0]);
      await typeInto(view, "password", "correct horse battery staple");
      await typeInto(view, "confirmation", "delete my account");
      const withoutCode = disabled(view, "Delete account");
      await typeInto(view, "code", "abcd-efgh-ijkl-mnop");
      await view.click(buttons(view, "Delete account").at(-1));

      expect({ sent, withoutCode }).toEqual({
        sent: [
          [
            "deleteAccountFn",
            { code: "abcd-efgh-ijkl-mnop", password: "correct horse battery staple" },
          ],
        ],
        withoutCode: true,
      });
    });
  });

  test("a recent email change the old address can still report blocks deletion", async () => {
    const blocked: AccountProfile = {
      ...allowed,
      deletion: {
        blockers: [{ kind: "held", until: "2026-10-16T12:00:00.000Z" }],
        kind: "blocked",
      },
    };
    await renderAccount(blocked, off, async (view) => {
      const callout = card(view, "Delete account")?.querySelector("[role=alert]");
      expect(buttons(view, "Delete account")).toHaveLength(0);
      expect(callout?.querySelector("li")?.textContent).toStartWith(
        "Your email changed recently. You can delete your account after",
      );
    });
  });

  test("the only owner of an organization sees why, with links to fix it, and no button", async () => {
    const blocked: AccountProfile = {
      ...allowed,
      deletion: {
        blockers: [{ kind: "sole-owner", organizationId: ORG, organizationName: "Acme" }],
        kind: "blocked",
      },
    };
    await renderAccount(blocked, off, async (view) => {
      const callout = card(view, "Delete account")?.querySelector("[role=alert]");
      expect({
        button: buttons(view, "Delete account").length,
        links: [...(callout?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href")),
        text: callout?.querySelector("li")?.textContent,
      }).toEqual({
        button: 0,
        links: [`/o/${ORG}/members`, `/o/${ORG}/governance`],
        text: "You are the only owner of Acme. Make another member an owner or erase the organization.",
      });
    });
  });
});
