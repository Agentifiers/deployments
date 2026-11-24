import { PublicId } from "@deployments-ai/api-contract/primitives";
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { act, type ReactNode } from "react";
import { withClient, type ClientView } from "@/components/ui/render-client";
import * as mutations from "../../data/system-mutations.ts";
import { TIMESTAMP_FORMAT } from "../observability/panels.tsx";
import {
  systemPersonByEmailQuery,
  systemPersonQuery,
  systemSecurityEventsQuery,
} from "../../data/system-queries.ts";
import type {
  SystemPerson,
  SystemPersonMatch,
  SystemSecurityEvent,
} from "../../server/system-data.ts";
import { PersonDetail } from "./person-detail.tsx";
import { PersonSearch } from "./person-search.tsx";

const id = Schema.decodeUnknownSync(PublicId);
const PERSON = id("01K00000000000000000000PER");
const SELF = id("01K00000000000000000000SEF");
const ORG = id("01K000000000000000000000G1");
const AT = "2026-10-09T12:00:00.000Z";

const person: SystemPerson = {
  createdAt: AT,
  displayName: "Ada Lovelace",
  id: PERSON,
  kind: "human",
  organizations: {
    capped: false,
    items: [
      {
        joinedAt: AT,
        name: "Acme",
        organizationId: ORG,
        organizationStatus: "active",
        role: "owner",
        slug: "acme",
        status: "active",
      },
    ],
  },
  platformRole: null,
  primaryEmail: "ada@example.com",
  signIn: {
    emailVerifiedAt: AT,
    mfa: { activatedAt: AT, recoveryCodesRemaining: 7, state: "active" },
    sessions: { browser: 2, capped: false, refreshTokenFamilies: 1 },
  },
  status: "active",
  updatedAt: AT,
};

const event = (eventId: string, eventType: string): SystemSecurityEvent => ({
  actor: { id: SELF, type: "principal" },
  details: { reason: "Account takeover report" },
  eventType,
  id: id(eventId),
  occurredAt: AT,
  withheldFields: ["tokenHash"],
});

const sent: { readonly data: unknown; readonly fn: string }[] = [];
const recorded =
  (fn: string, result: () => unknown) =>
  async ({ data }: { readonly data: unknown }) => {
    sent.push({ data, fn });
    return result();
  };

spyOn(mutations, "replacePrincipalStatusFn").mockImplementation(
  recorded("replacePrincipalStatusFn", () => ({
    changed: true,
    principalId: PERSON,
    status: "disabled",
    updatedAt: AT,
  })) as never,
);
spyOn(mutations, "revokePrincipalSessionsFn").mockImplementation(
  recorded("revokePrincipalSessionsFn", () => ({
    principalId: PERSON,
    sessionsEndedAt: AT,
  })) as never,
);
spyOn(mutations, "resendPrincipalVerificationFn").mockImplementation(
  recorded("resendPrincipalVerificationFn", () => ({
    email: "pending@example.com",
    principalId: PERSON,
    sentAt: AT,
  })) as never,
);
afterAll(() => {
  mock.restore();
});

/** Sets a controlled field by name the way React sees a user edit. */
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

async function submit(view: ClientView, name: string) {
  const form = view.document.querySelector(`input[name="${name}"]`)?.closest("form");
  if (!form) throw new Error(`no form around ${name}`);
  await act(async () => {
    form.dispatchEvent(
      new view.document.defaultView!.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
}

const button = (view: ClientView, text: string) =>
  [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);

async function render(
  ui: ReactNode,
  queryClient: QueryClient,
  run: (view: ClientView) => Promise<void>,
) {
  sent.length = 0;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
  });
  await router.load();
  return withClient(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
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

function seeded(detail: SystemPerson = person, events: readonly SystemSecurityEvent[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(systemPersonQuery(detail.id).queryKey, detail);
  queryClient.setQueryData(systemSecurityEventsQuery(detail.id).queryKey, {
    pageParams: [undefined],
    pages: [{ items: events, nextCursor: "next" }],
  });
  return queryClient;
}

describe("person detail", () => {
  test("shows who the person is, where they belong, and redacted security events", async () => {
    const seen: Record<string, unknown> = {};
    await render(
      <PersonDetail principalId={PERSON} selfPrincipalId={SELF} />,
      seeded(person, [event("01K0000000000000000000EVE1", "identity.sessions-invalidated")]),
      async (view) => {
        const text = (selector: string) =>
          [...view.document.querySelectorAll(selector)].map((node) => node.textContent?.trim());
        seen["terms"] = text("dt").map((term, index) => [term, text("dd")[index]]);
        seen["organizations"] = [...view.document.querySelectorAll("a")]
          .filter((link) => link.getAttribute("href")?.startsWith("/system/organizations/"))
          .map((link) => [link.textContent, link.getAttribute("href")]);
        seen["event"] = text("tbody tr").at(-1);
        seen["loadMore"] = button(view, "Load more") !== undefined;
      },
    );
    expect(seen["terms"]).toEqual([
      ["Email", "ada@example.com"],
      ["Email verified", new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT)],
      ["Multi-factor", "Enrolled, 7 recovery codes left"],
      ["Active sessions", "2 browser, 1 refresh token"],
      ["Created", new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT)],
      ["Updated", new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT)],
    ]);
    expect(seen["organizations"]).toEqual([["Acme", `/system/organizations/${ORG}`]]);
    expect(seen["event"]).toBe(
      `identity.sessions-invalidated${new Date(AT).toLocaleString(undefined, TIMESTAMP_FORMAT)}principal …${SELF.slice(-8)}reason: Account takeover reportWithheld: tokenHash`,
    );
    expect(seen["loadMore"]).toBe(true);
  });

  test("disabling needs a reason and the typed phrase with the ID's tail", async () => {
    const ready: (boolean | undefined)[] = [];
    await render(
      <PersonDetail principalId={PERSON} selfPrincipalId={SELF} />,
      seeded(),
      async (view) => {
        await view.click(button(view, "Disable…"));
        const enabled = () => button(view, "Disable person")?.matches(":disabled") === false;
        await typeInto(view, "confirmation", `disable ${PERSON.slice(-8)}`);
        ready.push(enabled());
        await typeInto(view, "reason", "Fraudulent sign-ups");
        ready.push(enabled());
        await view.click(button(view, "Disable person"));
      },
    );
    expect(ready).toEqual([false, true]);
    expect(sent).toEqual([
      {
        data: { body: { reason: "Fraudulent sign-ups", status: "disabled" }, principalId: PERSON },
        fn: "replacePrincipalStatusFn",
      },
    ]);
  });

  test("ending sessions sends the reason after the typed phrase", async () => {
    await render(
      <PersonDetail principalId={PERSON} selfPrincipalId={SELF} />,
      seeded(),
      async (view) => {
        await view.click(button(view, "End sessions…"));
        await typeInto(view, "reason", "Lost laptop");
        await typeInto(view, "confirmation", `revoke ${PERSON.slice(-8)}`);
        await view.click(button(view, "End sessions"));
      },
    );
    expect(sent).toEqual([
      {
        data: { body: { reason: "Lost laptop" }, principalId: PERSON },
        fn: "revokePrincipalSessionsFn",
      },
    ]);
  });

  test("an administrator cannot change their own status but may end their own sessions", async () => {
    let disabled: (boolean | undefined)[] = [];
    await render(
      <PersonDetail principalId={SELF} selfPrincipalId={SELF} />,
      seeded({ ...person, id: SELF }),
      async (view) => {
        disabled = ["Disable…", "End sessions…"].map((text) =>
          button(view, text)?.matches(":disabled"),
        );
      },
    );
    expect(disabled).toEqual([true, false]);
  });

  test("sign-in actions are off where the identity provider manages the person", async () => {
    let disabled: (boolean | undefined)[] = [];
    await render(
      <PersonDetail principalId={PERSON} selfPrincipalId={SELF} />,
      seeded({ ...person, signIn: null }),
      async (view) => {
        disabled = ["Disable…", "End sessions…"].map((text) =>
          button(view, text)?.matches(":disabled"),
        );
      },
    );
    expect(disabled).toEqual([true, true]);
  });
});

describe("person search", () => {
  const search = async (
    match: SystemPersonMatch | null,
    run: (view: ClientView) => Promise<void>,
  ) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    queryClient.setQueryData(systemPersonByEmailQuery("ada@example.com").queryKey, match);
    const opened: string[] = [];
    await render(
      <PersonSearch onPrincipalId={(principal) => opened.push(principal)} />,
      queryClient,
      async (view) => {
        await typeInto(view, "email", "ada@example.com");
        await submit(view, "email");
        await run(view);
      },
    );
    return opened;
  };
  const matchText = (view: ClientView) =>
    view.document.querySelector('[data-testid="person-match"]')?.textContent;

  test("links a found person to their page", async () => {
    let link: string | null | undefined;
    await search(
      {
        kind: "person",
        person: {
          createdAt: AT,
          displayName: "Ada Lovelace",
          id: PERSON,
          kind: "human",
          platformRole: null,
          primaryEmail: "ada@example.com",
          status: "active",
          updatedAt: AT,
        },
      },
      async (view) => {
        link = view.document.querySelector('[data-testid="person-match"] a')?.getAttribute("href");
      },
    );
    expect(link).toBe(`/system/people/${PERSON}`);
  });

  test("says nobody matched and that search is exact", async () => {
    let text: string | null | undefined;
    await search(null, async (view) => {
      text = matchText(view);
    });
    expect(text).toBe(
      "Nobody has the email ada@example.com. Search matches the whole address, not a prefix.",
    );
  });

  test("resends a pending sign-up's verification with its email and a reason", async () => {
    await search(
      {
        kind: "sign-up",
        signUp: {
          createdAt: AT,
          email: "pending@example.com",
          expiresAt: AT,
          principalId: PERSON,
          verificationEmailSentAt: AT,
        },
      },
      async (view) => {
        await view.click(button(view, "Resend verification…"));
        await typeInto(view, "reason", "Email went to spam");
        await view.click(button(view, "Send email"));
      },
    );
    expect(sent).toEqual([
      {
        data: {
          body: { email: "pending@example.com", reason: "Email went to spam" },
          principalId: PERSON,
        },
        fn: "resendPrincipalVerificationFn",
      },
    ]);
  });

  test("opens a pasted principal ID and refuses anything else", async () => {
    const queryClient = new QueryClient();
    const opened: string[] = [];
    let problem: string | null | undefined;
    await render(
      <PersonSearch onPrincipalId={(principal) => opened.push(principal)} />,
      queryClient,
      async (view) => {
        await typeInto(view, "principalId", "not-an-id");
        problem = view.document.querySelector('[data-slot="field-error"]')?.textContent;
        await typeInto(view, "principalId", ` ${PERSON} `);
        await submit(view, "principalId");
      },
    );
    expect(problem).toBe("Not a principal ID");
    expect(opened).toEqual([PERSON]);
  });
});
