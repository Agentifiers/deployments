import { afterAll, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { AccountSecurity, AccountSession } from "../../account/account-security.ts";
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

const AT = "2026-10-09T12:00:00.000Z";
const CODES = Array.from({ length: 10 }, (_, index) => `AAAA-BBBB-CCCC-DD${index}A`);

const sent: [string, unknown][] = [];
function stub(name: keyof typeof mutations, result: unknown) {
  const record = (input?: { readonly data?: unknown }) => {
    sent.push([name, input?.data]);
    return Promise.resolve(result);
  };
  spyOn(mutations, name).mockImplementation(record as never);
}
stub("beginMfaEnrollmentFn", {
  otpauthUri: "otpauth://totp/Deployments:ada%40example.com?secret=JBSWY3DPEHPK3PXP",
  secret: "JBSWY3DPEHPK3PXP",
});
stub("confirmMfaEnrollmentFn", { recoveryCodes: CODES });
stub("disableMfaFn", {});
stub("changeAccountPasswordFn", {});
stub("revokeAccountSessionFn", { current: false });
stub("signOutEverywhereFn", {});
stub("regenerateRecoveryCodesFn", { recoveryCodes: CODES });
afterAll(() => {
  mock.restore();
});
beforeEach(() => {
  sent.length = 0;
});

const session = (id: string, current: boolean, deviceLabel?: string): AccountSession => ({
  authenticationTime: AT,
  createdAt: AT,
  current,
  ...(deviceLabel ? { deviceLabel } : {}),
  expiresAt: AT,
  id,
  idleExpiresAt: AT,
  lastRefreshedAt: AT,
});

/** The `/account` route, its loader reading the seeded cache, under a memory router. */
async function renderAccount(security: AccountSecurity, run: (view: ClientView) => Promise<void>) {
  const queryClient = client(security);
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

function client(security: AccountSecurity) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(accountSecurityQuery().queryKey, security);
  queryClient.setQueryData(accountProfileQuery().queryKey, {
    deletion: { kind: "allowed", leaves: [] },
    email: "ada@example.com",
    emailChange: { kind: "available" },
  });
  queryClient.setQueryData(accountSessionsQuery().queryKey, {
    pageParams: [undefined],
    pages: [
      {
        items: [
          session("01K000000000000000000000S1", true, "Chrome on macOS"),
          session("01K000000000000000000000S2", false),
        ],
      },
    ],
  });
  return queryClient;
}

const off: AccountSecurity = { mfa: { state: "off" }, passwordSignIn: true };
const on: AccountSecurity = {
  mfa: { activatedAt: AT, recoveryCodesRemaining: 2, state: "on" },
  passwordSignIn: true,
};

const titles = (view: ClientView) =>
  [...view.document.querySelectorAll("[data-slot=card-title]")].map((node) => node.textContent);
const dialogTitle = (view: ClientView) =>
  view.document.querySelector("[role=dialog] h2")?.textContent;
const disabled = (view: ClientView, label: string) =>
  buttons(view, label).at(-1)?.hasAttribute("disabled");

/** Records the account sign-out form instead of letting jsdom navigate. */
function signOuts(view: ClientView) {
  const submitted: string[] = [];
  view.document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    const action = form.getAttribute("action");
    if (action === null) return;
    event.preventDefault();
    const fields = [...form.querySelectorAll("input")].map((input) => [input.name, input.value]);
    submitted.push(`${action} ${new URLSearchParams(fields)}`);
  });
  return submitted;
}

describe("account page", () => {
  test("shows the password, two-factor, and session controls, marking this browser", async () => {
    await renderAccount(off, async (view) => {
      expect({
        rows: [...view.document.querySelectorAll("tbody tr")].map(
          (row) => row.querySelector("td span")?.textContent,
        ),
        signOut: buttons(view, "Sign out").length,
        titles: titles(view),
        turnOn: buttons(view, "Turn on").length,
      }).toEqual({
        rows: ["Chrome on macOSthis browser", "Unknown browser"],
        signOut: 2,
        titles: [
          "Email",
          "Password",
          "Two-factor authentication off",
          "Browser sessions",
          "Delete account",
        ],
        turnOn: 1,
      });
    });
  });

  test("an account that signs in through its identity provider has no password or two-factor controls", async () => {
    await renderAccount({ mfa: { state: "off" }, passwordSignIn: false }, async (view) => {
      expect({
        changePassword: buttons(view, "Change password").length,
        titles: titles(view),
        turnOn: buttons(view, "Turn on").length,
      }).toEqual({
        changePassword: 0,
        titles: ["Email", "Sign-in", "Browser sessions", "Delete account"],
        turnOn: 0,
      });
    });
  });

  test("enrollment takes the password, shows the setup key, confirms a code, then holds the recovery codes until stored", async () => {
    await renderAccount(off, async (view) => {
      await view.click(buttons(view, "Turn on")[0]);
      const steps: unknown[] = [dialogTitle(view), disabled(view, "Continue")];
      await typeInto(view, "password", "correct horse battery staple");
      await view.click(buttons(view, "Continue").at(-1));
      steps.push(
        dialogTitle(view),
        view.document.querySelector("[role=dialog] svg[role=img]")?.getAttribute("aria-label"),
        view.document.querySelector<HTMLInputElement>('input[aria-label="Setup key"]')?.value,
        disabled(view, "Turn on"),
      );
      await typeInto(view, "code", "123 456");
      await view.click(buttons(view, "Turn on").at(-1));
      steps.push(
        dialogTitle(view),
        view.document.querySelectorAll("[aria-label='Recovery codes'] li").length,
        disabled(view, "Done"),
      );
      await view.click(view.document.querySelector("[role=dialog] [role=checkbox]"));
      steps.push(disabled(view, "Done"));
      await view.click(buttons(view, "Done")[0]);
      steps.push(view.document.querySelector("[role=dialog]") === null);
      expect({ sent, steps }).toEqual({
        sent: [
          ["beginMfaEnrollmentFn", { password: "correct horse battery staple" }],
          ["confirmMfaEnrollmentFn", { code: "123 456" }],
        ],
        steps: [
          "Turn on two-factor authentication",
          true,
          "Add to your authenticator",
          "QR code for your authenticator app",
          "JBSWY3DPEHPK3PXP",
          true,
          "Store your recovery codes",
          10,
          true,
          false,
          true,
        ],
      });
    });
  });

  test("with two-factor on, the page counts recovery codes and turning it off needs a code", async () => {
    await renderAccount(on, async (view) => {
      const remaining = [...view.document.querySelectorAll("[data-slot=card-content] p")].find(
        (node) => node.textContent?.includes("recovery code"),
      )?.textContent;
      await view.click(buttons(view, "Turn off")[0]);
      const before = disabled(view, "Turn off");
      await typeInto(view, "code", "aaaa-bbbb-cccc-dddd");
      await view.click(buttons(view, "Turn off").at(-1));
      expect({ before, remaining, sent }).toEqual({
        before: true,
        remaining: "2 unused recovery codes left. Replace them before you run out.",
        sent: [["disableMfaFn", { code: "aaaa-bbbb-cccc-dddd" }]],
      });
    });
  });

  test("changing the password checks the new one, then signs this console out to sign in again", async () => {
    await renderAccount(off, async (view) => {
      const submitted = signOuts(view);
      await view.click(buttons(view, "Change password")[0]);
      await typeInto(view, "currentPassword", "an old password of some length");
      await typeInto(view, "password", "too short");
      await typeInto(view, "confirmation", "too short");
      const short = disabled(view, "Change password");
      await typeInto(view, "password", "a new password that is long enough");
      await typeInto(view, "confirmation", "a new password that is long enough");
      const valid = disabled(view, "Change password");
      await view.click(buttons(view, "Change password").at(-1));
      expect({ sent, short, submitted, valid }).toEqual({
        sent: [
          [
            "changeAccountPasswordFn",
            {
              currentPassword: "an old password of some length",
              password: "a new password that is long enough",
            },
          ],
        ],
        short: true,
        submitted: ["/auth/logout prompt=login&returnTo=%2Faccount"],
        valid: false,
      });
    });
  });

  test("signing out another session revokes it by id and keeps this console signed in", async () => {
    await renderAccount(off, async (view) => {
      const submitted = signOuts(view);
      await view.click(
        view.document.querySelector(`button[aria-label="Sign out the session from ${AT}"]`),
      );
      await view.click(buttons(view, "Sign out").at(-1));
      expect({ sent, submitted }).toEqual({
        sent: [["revokeAccountSessionFn", { sessionId: "01K000000000000000000000S2" }]],
        submitted: [],
      });
    });
  });
});
