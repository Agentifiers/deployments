import { describe, expect, test } from "bun:test";
import { describeProblem } from "../components/section-boundary.tsx";
import { PlatformApiError } from "../errors.ts";
import {
  attachAppDomain,
  detachAppDomain,
  eraseApp,
  putAppGrant,
  refreshAppDomain,
  setAppPublication,
} from "./app-actions.ts";
import { loadAppDomains, loadAppGrants, type AppsPlatform } from "./app-data.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
const APP = "01K000000000000000000000AP";
const ALICE = "01K000000000000000000000A1";
const BOB = "01K000000000000000000000B2";
const AT = "2026-10-09T12:00:00.000Z";

interface Sent {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly method: string;
  readonly path: string;
}

function platform(respond: (path: string) => Response) {
  const sent: Sent[] = [];
  const queries: string[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      queries.push(url.search);
      sent.push({
        body: request.body === null ? undefined : await request.json(),
        headers: {
          environment: request.headers.get("x-deployments-environment"),
          idempotencyKey: request.headers.get("idempotency-key"),
          organization: request.headers.get("x-deployments-organization"),
        },
        method: request.method,
        path: url.pathname,
      });
      return respond(url.pathname);
    }) as typeof globalThis.fetch,
  });
  return { client, queries, sent };
}

function member(principalId: string, displayName: string) {
  return {
    createdAt: AT,
    displayName,
    id: principalId,
    joinedAt: AT,
    organizationId: scope.organizationId,
    principalId,
    role: "member",
    status: "active",
    updatedAt: AT,
    version: 1,
  };
}

const grant = {
  appId: APP,
  createdAt: AT,
  grantedBy: ALICE,
  principalId: BOB,
  role: "editor",
  updatedAt: AT,
};

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : undefined),
  );
}

describe("loadAppGrants", () => {
  test("names each grant by member and offers the members without one", async () => {
    const { client, sent } = platform((path) =>
      Response.json(
        path === "/v1/members"
          ? { items: [member(ALICE, "Alice"), member(BOB, "Bob")] }
          : { items: [grant] },
      ),
    );
    expect(await loadAppGrants("token", scope, APP, client)).toEqual({
      candidates: [{ name: "Alice", principalId: ALICE }],
      grants: [
        { memberActive: true, name: "Bob", principalId: BOB, role: "editor", updatedAt: AT },
      ],
    });
    expect(sent.map(({ headers, path }) => ({ headers, path }))).toEqual([
      {
        headers: {
          environment: scope.environmentId,
          idempotencyKey: null,
          organization: scope.organizationId,
        },
        path: `/v1/apps/${APP}/grants`,
      },
      {
        headers: { environment: null, idempotencyKey: null, organization: scope.organizationId },
        path: "/v1/members",
      },
    ]);
  });

  test("a 403 renders as the console's standard refusal", async () => {
    const { client } = platform(() =>
      Response.json({ status: 403, title: "Forbidden" }, { status: 403 }),
    );
    const error = await failure(loadAppGrants("token", scope, APP, client));
    expect(describeProblem(error ?? new Error("resolved"), "This section failed to load")).toEqual({
      description: "Your role or API key scopes do not allow this action.",
      requestId: undefined,
      status: 403,
      title: "Forbidden",
    });
  });
});

describe("putAppGrant", () => {
  test("puts the role on the member's grant under the dialog's key", async () => {
    const { client, sent } = platform(() => Response.json(grant));
    const saved = await putAppGrant(
      {
        accessToken: "token",
        appId: APP,
        body: { role: "editor" },
        idempotencyKey: "dialog-key",
        principalId: BOB,
        scope,
      },
      client,
    );
    expect<unknown>({ principalId: saved.principalId, role: saved.role }).toEqual({
      principalId: BOB,
      role: "editor",
    });
    expect(sent).toEqual([
      {
        body: { role: "editor" },
        headers: {
          environment: scope.environmentId,
          idempotencyKey: "dialog-key",
          organization: scope.organizationId,
        },
        method: "PUT",
        path: `/v1/apps/${APP}/grants/${BOB}`,
      },
    ]);
  });

  test("refuses a role outside the contract before calling the platform", async () => {
    const { client, sent } = platform(() => Response.json(grant));
    const error = await failure(
      Promise.resolve().then(() =>
        putAppGrant(
          {
            accessToken: "token",
            appId: APP,
            body: { role: "owner" },
            idempotencyKey: "dialog-key",
            principalId: BOB,
            scope,
          },
          client,
        ),
      ),
    );
    expect(error instanceof PlatformApiError ? error.problem : error).toEqual({
      detail: "The request has an invalid value at role.",
      status: 400,
      title: "Invalid request",
    });
    expect(sent).toEqual([]);
  });
});

const DOMAIN = "01K000000000000000000000D1";
const ROUTING = "routing.apps.example.test";

function domain(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP,
    attachedBy: { id: ALICE, principal: "human" },
    createdAt: AT,
    dnsRecords: [
      {
        name: "_deployments-app.www.example.com",
        type: "TXT",
        value: "deployments-app=0123456789abcdef0123456789abcdef",
      },
      {
        name: "www.example.com",
        note: "A zone apex cannot hold a CNAME.",
        type: "CNAME",
        value: ROUTING,
      },
    ],
    hostname: "www.example.com",
    id: DOMAIN,
    state: { kind: "unverified" },
    updatedAt: AT,
    ...overrides,
  };
}

function app(publication: { audience: string; serving: string }) {
  return {
    access: { organizationMembers: "viewer" },
    agentDefinitionId: "01K000000000000000000000AD",
    createdAt: AT,
    createdBy: { principalId: ALICE, runId: "01K000000000000000000000RN" },
    environmentId: scope.environmentId,
    id: APP,
    lifecycle: { liveReleaseId: null, state: "active" },
    name: "Sign-up form",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    publication,
    slug: "sign-up",
    updatedAt: AT,
    url: "https://sign-up.apps.example.test",
    workspaceId: "01K000000000000000000000WS",
  };
}

const mutation = { accessToken: "token", appId: APP, idempotencyKey: "dialog-key", scope };

describe("loadAppDomains", () => {
  test("follows the cursor and returns every domain with its DNS records", async () => {
    const second = domain({
      hostname: "example.com",
      id: "01K000000000000000000000D2",
      state: { kind: "verified", problem: null, verifiedAt: AT },
    });
    let calls = 0;
    const { client, queries, sent } = platform(() =>
      Response.json(
        calls++ === 0 ? { items: [domain()], nextCursor: "next-page" } : { items: [second] },
      ),
    );
    const domains = await loadAppDomains("token", scope, APP, client);
    expect(domains.map(({ hostname, state }) => ({ hostname, state: state.kind }))).toEqual([
      { hostname: "www.example.com", state: "unverified" },
      { hostname: "example.com", state: "verified" },
    ]);
    expect(domains[0]?.dnsRecords.map(({ type, value }) => `${type} ${value}`)).toEqual([
      "TXT deployments-app=0123456789abcdef0123456789abcdef",
      `CNAME ${ROUTING}`,
    ]);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /v1/apps/${APP}/domains`,
      `GET /v1/apps/${APP}/domains`,
    ]);
    expect(queries).toEqual(["?limit=100", "?cursor=next-page&limit=100"]);
  });
});

describe("publication and domain writes", () => {
  test("setAppPublication patches both settings under the dialog's key", async () => {
    const { client, sent } = platform(() =>
      Response.json(app({ audience: "public", serving: "static-site" })),
    );
    const updated = await setAppPublication(
      { ...mutation, body: { audience: "public", serving: "static-site" } },
      client,
    );
    expect<unknown>(updated.publication).toEqual({ audience: "public", serving: "static-site" });
    expect(sent).toEqual([
      {
        body: { audience: "public", serving: "static-site" },
        headers: {
          environment: scope.environmentId,
          idempotencyKey: "dialog-key",
          organization: scope.organizationId,
        },
        method: "PATCH",
        path: `/v1/apps/${APP}/publication`,
      },
    ]);
  });

  test("setAppPublication refuses an empty change before calling the platform", async () => {
    const { client, sent } = platform(() => Response.json({}));
    const error = await failure(
      Promise.resolve().then(() => setAppPublication({ ...mutation, body: {} }, client)),
    );
    expect(error instanceof PlatformApiError ? error.problem.status : error).toBe(400);
    expect(sent).toEqual([]);
  });

  test("attach refuses a non-string hostname before calling the platform", async () => {
    const { client, sent } = platform(() => Response.json(domain()));
    const error = await failure(
      Promise.resolve().then(() =>
        attachAppDomain({ ...mutation, body: { hostname: 42 } }, client),
      ),
    );
    expect(error instanceof PlatformApiError ? error.problem : error).toEqual({
      detail: "The request has an invalid value at hostname.",
      status: 400,
      title: "Invalid request",
    });
    expect(sent).toEqual([]);
  });

  test("attach posts the hostname, refresh posts without a key, and detach deletes by id", async () => {
    const verified = domain({ state: { kind: "verified", problem: null, verifiedAt: AT } });
    const { client, sent } = platform(() => Response.json(verified));
    await attachAppDomain({ ...mutation, body: { hostname: "www.example.com" } }, client);
    const refreshed = await refreshAppDomain(
      { accessToken: "token", appId: APP, domainId: DOMAIN, scope },
      client,
    );
    await detachAppDomain({ ...mutation, domainId: DOMAIN }, client);
    expect(refreshed.state.kind).toBe("verified");
    expect(
      sent.map(({ body, headers, method, path }) => [method, path, headers.idempotencyKey, body]),
    ).toEqual([
      ["POST", `/v1/apps/${APP}/domains`, "dialog-key", { hostname: "www.example.com" }],
      ["POST", `/v1/apps/${APP}/domains/${DOMAIN}/refresh`, null, undefined],
      ["DELETE", `/v1/apps/${APP}/domains/${DOMAIN}`, "dialog-key", undefined],
    ]);
  });

  test.each([
    {
      expected: {
        code: "dns_lookup_failed",
        detail: "Try again.",
        retryAfterSeconds: 5,
        status: 503,
        title: "Request failed",
      },
      name: "a problem body",
      response: () =>
        Response.json(
          { code: "dns_lookup_failed", detail: "Try again.", status: 503, title: "Request failed" },
          { headers: { "retry-after": "5" }, status: 503 },
        ),
    },
    {
      expected: { retryAfterSeconds: 120, status: 503, title: "Service Unavailable" },
      name: "a plain-text body",
      response: () =>
        new Response("busy", {
          headers: { "retry-after": "120" },
          status: 503,
          statusText: "Service Unavailable",
        }),
    },
    {
      expected: { status: 503, title: "Service Unavailable" },
      name: "an HTTP date, which it drops",
      response: () =>
        new Response("busy", {
          headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
          status: 503,
          statusText: "Service Unavailable",
        }),
    },
    ...(
      [
        ["the longest delay a browser timer holds", "2147483", { retryAfterSeconds: 2_147_483 }],
        [
          "a delay past what a browser timer holds, which it drops so the check keeps its own back-off",
          "2147484",
          {},
        ],
        ["a 400-digit delay, which it drops", "9".repeat(400), {}],
      ] as const
    ).map(([name, header, kept]) => ({
      expected: { ...kept, status: 503, title: "Service Unavailable" },
      name,
      response: () =>
        new Response("busy", {
          headers: { "retry-after": header },
          status: 503,
          statusText: "Service Unavailable",
        }),
    })),
  ])("a refused refresh keeps Retry-After seconds from $name", async ({ expected, response }) => {
    const { client } = platform(response);
    const error = await failure(
      refreshAppDomain({ accessToken: "token", appId: APP, domainId: DOMAIN, scope }, client),
    );
    expect(error instanceof PlatformApiError ? error.problem : error).toEqual(expected);
  });
});

describe("the API's own messages reach the dialog", () => {
  const problem = (status: number, code: string, detail: string) =>
    Response.json(
      { code, detail, requestId: "req-1", status, title: "Request failed" },
      { status },
    );

  test.each([
    {
      call: (client: AppsPlatform) => eraseApp(mutation, client),
      expected: {
        description:
          "App 01K000000000000000000000AP may still be provisioning; erasure becomes possible after 2026-10-09T12:10:00.000Z.",
        title: "The app cannot be deleted yet",
      },
      response: problem(
        409,
        "app_state_conflict",
        "App 01K000000000000000000000AP may still be provisioning; erasure becomes possible after 2026-10-09T12:10:00.000Z.",
      ),
    },
    {
      call: (client: AppsPlatform) =>
        setAppPublication({ ...mutation, body: { audience: "public" } }, client),
      expected: { description: "The app request failed.", title: "Publication not changed yet" },
      response: problem(500, "internal_error", "The app request failed."),
    },
    {
      call: (client: AppsPlatform) =>
        setAppPublication({ ...mutation, body: { audience: "public" } }, client),
      expected: {
        description: `App ${APP} is archived; set-publication needs provisioning or active.`,
        title: "Not possible in the app's current state",
      },
      response: problem(
        409,
        "app_state_conflict",
        `App ${APP} is archived; set-publication needs provisioning or active.`,
      ),
    },
    {
      call: (client: AppsPlatform) =>
        refreshAppDomain({ accessToken: "token", appId: APP, domainId: DOMAIN, scope }, client),
      expected: {
        description: "www.example.com is already verified for another app.",
        title: "Another app verified this hostname",
      },
      response: problem(
        409,
        "domain_claimed",
        "www.example.com is already verified for another app.",
      ),
    },
  ])("$expected.title", async ({ call, expected, response }) => {
    const { client } = platform(() => response.clone());
    const error = await failure(call(client));
    const { description, title } = describeProblem(error ?? new Error("resolved"), "Failed");
    expect({ description, title }).toEqual(expected);
  });
});
