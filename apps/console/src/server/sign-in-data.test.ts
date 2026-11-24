import { describe, expect, test } from "bun:test";
import { describeProblem } from "../components/section-boundary.tsx";
import { createPlatformApiClient } from "./platform-api.ts";
import { setIdentityProviderState } from "./sign-in-actions.ts";
import { loadIdentityProvider, loadLoginDomains } from "./sign-in-data.ts";

const scope = { organizationId: "01K000000000000000000000G1" };

function platform(respond: (request: Request) => Response) {
  const sent: { readonly headers: string[]; readonly method: string; readonly path: string }[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        headers: [...request.headers.keys()].filter((name) => name.startsWith("x-deployments-")),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return respond(request);
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => new Error("resolved"),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

describe("loadIdentityProvider", () => {
  test("an organization without an identity provider loads as null", async () => {
    const { client, sent } = platform(() =>
      Response.json(
        {
          code: "identity_provider_not_found",
          detail: "The organization has no identity provider.",
          status: 404,
          title: "Request failed",
        },
        { status: 404 },
      ),
    );
    expect(await loadIdentityProvider("token", scope, client)).toBeNull();
    expect(sent).toEqual([
      { headers: ["x-deployments-organization"], method: "GET", path: "/v1/identity-provider" },
    ]);
  });

  test("a member's 403 renders as the role refusal with the API's reason", async () => {
    const { client } = platform(() =>
      Response.json(
        {
          code: "insufficient_role",
          detail: "Identity federation administration requires the owner or admin role.",
          requestId: "req-1",
          status: 403,
          title: "Forbidden",
        },
        { status: 403 },
      ),
    );
    const error = await failure(loadIdentityProvider("token", scope, client));
    expect(describeProblem(error, "This section failed to load")).toEqual({
      description: "Identity federation administration requires the owner or admin role.",
      requestId: "req-1",
      status: 403,
      title: "Your organization role does not permit this",
    });
  });
});

test("login domains are read with only the organization header", async () => {
  const { client, sent } = platform(() =>
    Response.json({
      items: [
        {
          createdAt: "2026-10-09T12:00:00.000Z",
          dnsRecord: {
            name: "_deployments-ai.example.com",
            type: "TXT",
            value: "deployments-ai-verification=abc",
          },
          domain: "example.com",
          id: "01K000000000000000000000D1",
          state: { kind: "pending" },
          updatedAt: "2026-10-09T12:00:00.000Z",
        },
      ],
    }),
  );
  const domains = await loadLoginDomains("token", scope, client);
  expect(domains.map(({ dnsRecord, domain }) => ({ dnsRecord, domain }))).toEqual([
    {
      dnsRecord: {
        name: "_deployments-ai.example.com",
        type: "TXT",
        value: "deployments-ai-verification=abc",
      },
      domain: "example.com",
    },
  ]);
  expect(sent).toEqual([
    { headers: ["x-deployments-organization"], method: "GET", path: "/v1/login-domains" },
  ]);
});

test("requiring sign-in surfaces the API's federated-session refusal", async () => {
  const { client } = platform(() =>
    Response.json(
      {
        code: "enforcement_requires_federated_session",
        detail: "Sign in through this organization's identity provider before requiring it.",
        status: 409,
        title: "Request failed",
      },
      { status: 409 },
    ),
  );
  const error = await failure(
    setIdentityProviderState(
      {
        accessToken: "token",
        body: { enforcement: "required", kind: "active" },
        idempotencyKey: "dialog-key",
        scope,
      },
      client,
    ),
  );
  expect(describeProblem(error, "The request failed")).toEqual({
    description: "Sign in through this organization's identity provider before requiring it.",
    requestId: undefined,
    status: 409,
    title: "Sign in through the identity provider first",
  });
});
