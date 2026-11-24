import { describe, expect, test } from "bun:test";

import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";

import {
  executeProviderNativeHttpTool,
  ProviderNativeExecutionKnownFailureError,
  ProviderNativeExecutionOutcomeUnknownError,
  providerNativeTransportInput,
} from "./executor.ts";
import { providerNativeHttpToolDefinitions } from "./registry.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];

const SENDGRID_CREDENTIAL = {
  externalAccountId: "sendgrid-account-1",
  fields: { apiKey: "sendgrid-secret-token-123456" },
  provider: "sendgrid",
} as const;
const SENDGRID_SEND_INPUT = {
  body: { from: { email: "sender@example.com" }, subject: "Approved send" },
} as const;

function definition(toolName: string) {
  const found = providerNativeHttpToolDefinitions.find((entry) => entry.toolName === toolName);
  if (!found) throw new Error(`Missing test definition ${toolName}.`);
  return found;
}

describe("provider-native HTTP executor", () => {
  test("removes the artifact handoff audit envelope before provider transport", () => {
    expect(
      providerNativeTransportInput({
        _artifactHandoff: { artifactId: "artifact", intentId: "intent" },
        recipient: "ops@example.com",
        text: "See https://artifacts.example/report.txt",
      }),
    ).toEqual({
      recipient: "ops@example.com",
      text: "See https://artifacts.example/report.txt",
    });
  });

  test("does not redispatch mutation requests through redirects", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];

    expect(
      executeProviderNativeHttpTool(
        {
          credential: SENDGRID_CREDENTIAL,
          definition: definition("sendgrid.email.send"),
          input: SENDGRID_SEND_INPUT,
          request: {
            idempotencyKey: "run-1:sendgrid-write",
            toolCallId: "01J00000000000000000000000",
            toolName: "sendgrid.email.send",
          },
        },
        {
          dnsLookup: PUBLIC_DNS,
          maxRedirects: 5,
          pinnedRequest: async (request) => {
            requests.push(request);
            return new Response(null, {
              headers: { location: "https://api.sendgrid.com/redirected" },
              status: 307,
            });
          },
        },
      ),
    ).rejects.toBeInstanceOf(ProviderNativeExecutionOutcomeUnknownError);
    expect(requests).toHaveLength(1);
  });

  test("builds an authenticated, DNS-pinned provider request and parses bounded JSON", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const result = await executeProviderNativeHttpTool(
      {
        credential: SENDGRID_CREDENTIAL,
        definition: definition("sendgrid.stats.read"),
        input: { endDate: "2026-01-31", startDate: "2026-01-01" },
        request: {
          idempotencyKey: "run-1:sendgrid-read",
          toolCallId: "01J00000000000000000000000",
          toolName: "sendgrid.stats.read",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return new Response(JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }), {
            headers: { "content-type": "application/json; charset=utf-8" },
            status: 200,
          });
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.url)).toBe(
      "https://api.sendgrid.com/v3/stats?start_date=2026-01-01&end_date=2026-01-31",
    );
    expect(requests[0]?.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(requests[0]?.headers?.authorization).toBe("Bearer sendgrid-secret-token-123456");
    expect(requests[0]?.headers?.["idempotency-key"]).toBeUndefined();
    expect(result).toMatchObject({
      itemCount: 2,
      provider: "sendgrid",
      requestHost: "api.sendgrid.com",
      responseStatus: 200,
    });
    expect(result.artifactBody).toContain('"id": 1');
  });

  test("adds idempotency for mutations and extracts a concrete operation id", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const result = await executeProviderNativeHttpTool(
      {
        credential: SENDGRID_CREDENTIAL,
        definition: definition("sendgrid.email.send"),
        input: SENDGRID_SEND_INPUT,
        request: {
          idempotencyKey: "run-1:sendgrid-send",
          toolCallId: "01J00000000000000000000001",
          toolName: "sendgrid.email.send",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return new Response(JSON.stringify({ id: "message-123" }), {
            headers: { "content-type": "application/json" },
            status: 202,
          });
        },
      },
    );

    expect(requests[0]?.headers?.["idempotency-key"]).toBe("run-1:sendgrid-send");
    expect(result.externalOperationId).toBe("message-123");
  });

  test("executes accepted shared Google OAuth credentials through the canonical tool provider", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    await executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "google-account-1",
          fields: { accessToken: "google-secret-token-123456" },
          provider: "google",
        },
        definition: definition("google_search_console.sites.list"),
        input: {},
        request: {
          idempotencyKey: "run-1:gsc-sites",
          toolName: "google_search_console.sites.list",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return new Response(JSON.stringify({ siteEntry: [] }), {
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.authorization).toBe("Bearer google-secret-token-123456");
    expect(String(requests[0]?.url)).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites",
    );
  });

  test("uses the verified credential origin instead of caller-supplied origin input", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    await executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "wordpress-account-1",
          fields: {
            appPassword: "wordpress-secret-password-123456",
            baseUrl: "https://site.example.com",
            username: "publisher",
          },
          provider: "wordpress",
        },
        definition: definition("wordpress.posts.list"),
        input: { baseUrl: "https://attacker.example.net", perPage: 5 },
        request: {
          idempotencyKey: "run-1:wordpress-read",
          toolName: "wordpress.posts.list",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return new Response("[]", {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      },
    );

    expect(String(requests[0]?.url)).toStartWith("https://site.example.com/wp-json/wp/v2/posts?");
    expect(requests[0]?.headers?.authorization).toStartWith("Basic ");
  });

  test("does not let caller input override a credential-bound OAuth resource", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    await executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "shopify-account-1",
          fields: { accessToken: "shopify-secret-token-123456" },
          provider: "shopify",
          resourceDefaults: { oauthResource: "https://store.myshopify.com" },
        },
        definition: definition("shopify.products.search"),
        input: {
          limit: 1,
          oauthResource: "https://attacker.myshopify.com",
        },
        request: {
          idempotencyKey: "run-1:shopify-override",
          toolName: "shopify.products.search",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return Response.json({ data: { products: { nodes: [] } } });
        },
      },
    );

    expect(String(requests[0]?.url)).toBe(
      "https://store.myshopify.com/admin/api/2026-07/graphql.json",
    );
  });

  test("binds Shopify OAuth resources to both origin validation and tool routing", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    await executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "shopify-account-1",
          fields: { accessToken: "shopify-secret-token-123456" },
          provider: "shopify",
          resourceDefaults: { oauthResource: "https://store.myshopify.com" },
        },
        definition: definition("shopify.products.search"),
        input: { limit: 1 },
        request: {
          idempotencyKey: "run-1:shopify-products",
          toolName: "shopify.products.search",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return Response.json({ data: { products: { nodes: [] } } });
        },
      },
    );

    expect(String(requests[0]?.url)).toBe(
      "https://store.myshopify.com/admin/api/2026-07/graphql.json",
    );
    expect(requests[0]?.headers?.["x-shopify-access-token"]).toBe("shopify-secret-token-123456");
  });

  test("preserves the raw API key expected by Basic-auth adapter callbacks", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const apiKey = "rewardful-secret-api-key-123456";
    await executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "rewardful-account-1",
          fields: { apiKey },
          provider: "rewardful",
        },
        definition: definition("rewardful.affiliates.list"),
        input: {},
        request: {
          idempotencyKey: "run-1:rewardful-read",
          toolName: "rewardful.affiliates.list",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return new Response(JSON.stringify({ data: [] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      },
    );

    expect(String(requests[0]?.url)).toStartWith("https://api.getrewardful.com/v1/affiliates");
    expect(requests[0]?.headers?.authorization).toBe(
      `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`,
    );
  });

  test("pins and bounds client-credentials exchange before the provider request", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const input = {
      credential: {
        externalAccountId: "hotjar-account-1",
        fields: {
          clientId: "hotjar-client-id-123456",
          clientSecret: "hotjar-client-secret-123456",
          siteId: "123456",
        },
        provider: "hotjar",
      },
      definition: definition("hotjar.surveys.list"),
      input: {},
      request: {
        idempotencyKey: "run-1:hotjar-surveys",
        toolName: "hotjar.surveys.list",
      },
    } as const;
    await executeProviderNativeHttpTool(input, {
      dnsLookup: PUBLIC_DNS,
      pinnedRequest: async (request) => {
        requests.push(request);
        if (String(request.url).includes("/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "hotjar-exchanged-token-123456",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        }
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    });

    expect(requests).toHaveLength(2);
    expect(String(requests[0]?.url)).toBe("https://api.hotjar.io/v1/oauth/token");
    expect(String(requests[1]?.url)).toBe("https://api.hotjar.io/v1/sites/123456/surveys");
    expect(requests[1]?.headers?.authorization).toBe("Bearer hotjar-exchanged-token-123456");
    expect(
      executeProviderNativeHttpTool(input, {
        dnsLookup: PUBLIC_DNS,
        maxTokenResponseBytes: 2,
        pinnedRequest: async () =>
          new Response("oversized", {
            headers: { "content-length": "9", "content-type": "text/plain" },
            status: 401,
          }),
      }),
    ).rejects.toThrow("returned HTTP 401");
  });

  test("retries only statuses allowed by the code-owned retry policy", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const delays: number[] = [];
    const base = definition("sendgrid.stats.read");
    await executeProviderNativeHttpTool(
      {
        credential: SENDGRID_CREDENTIAL,
        definition: {
          ...base,
          retryPolicy: {
            baseDelayMs: 10,
            maxAttempts: 2,
            maxDelayMs: 100,
            retryableStatusCodes: [503],
          },
        },
        input: {},
        request: {
          idempotencyKey: "run-1:sendgrid-retry",
          toolName: "sendgrid.stats.read",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? new Response("temporarily unavailable", { status: 503 })
            : new Response("{}", {
                headers: { "content-type": "application/json" },
                status: 200,
              });
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(requests).toHaveLength(2);
    expect(delays).toEqual([10]);
  });

  test("does not automatically retry provider mutations", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const delays: number[] = [];
    const base = definition("sendgrid.email.send");
    expect(
      executeProviderNativeHttpTool(
        {
          credential: SENDGRID_CREDENTIAL,
          definition: {
            ...base,
            retryPolicy: {
              baseDelayMs: 10,
              maxAttempts: 3,
              maxDelayMs: 100,
              retryableStatusCodes: [503],
            },
          },
          input: SENDGRID_SEND_INPUT,
          request: {
            idempotencyKey: "run-1:sendgrid-no-mutation-retry",
            toolName: "sendgrid.email.send",
          },
        },
        {
          dnsLookup: PUBLIC_DNS,
          pinnedRequest: async (request) => {
            requests.push(request);
            return new Response("temporarily unavailable", { status: 503 });
          },
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      ),
    ).rejects.toThrow("returned HTTP 503");

    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("treats execute effects as mutation-capable after dispatch", async () => {
    const requests: ExecutePinnedHttpRequestOptions[] = [];
    const base = definition("sendgrid.email.send");
    let failure: unknown;
    try {
      await executeProviderNativeHttpTool(
        {
          credential: SENDGRID_CREDENTIAL,
          definition: { ...base, effect: "execute" },
          input: SENDGRID_SEND_INPUT,
          request: {
            idempotencyKey: "run-1:sendgrid-execute",
            toolName: "sendgrid.email.send",
          },
        },
        {
          dnsLookup: PUBLIC_DNS,
          pinnedRequest: async (request) => {
            requests.push(request);
            return new Response("temporarily unavailable", { status: 503 });
          },
        },
      );
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(ProviderNativeExecutionOutcomeUnknownError);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.["idempotency-key"]).toBe("run-1:sendgrid-execute");
  });

  test("rejects private DNS, oversized bodies, invalid UTF-8, and credential echoes", async () => {
    const baseInput = {
      credential: SENDGRID_CREDENTIAL,
      definition: definition("sendgrid.stats.read"),
      input: {},
      request: {
        idempotencyKey: "run-1:sendgrid-invalid",
        toolName: "sendgrid.stats.read",
      },
    } as const;

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        pinnedRequest: async () => new Response("{}"),
      }),
    ).rejects.toThrow("public addresses");

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: PUBLIC_DNS,
        maxResponseBytes: 2,
        pinnedRequest: async () =>
          new Response("oversized", {
            headers: { "content-length": "9", "content-type": "text/plain" },
          }),
      }),
    ).rejects.toThrow("maximum of 2 bytes");

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(new Uint8Array([0xff]), {
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      }),
    ).rejects.toThrow("not valid UTF-8");

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(JSON.stringify({ token: "sendgrid-secret-token-123456" }), {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("contained credential material");

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(JSON.stringify({ value: "prefixsendgrid-secret-token-123456suffix" }), {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("contained credential material");

    expect(
      executeProviderNativeHttpTool(baseInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(JSON.stringify({ "sendgrid-secret-token-123456": "error" }), {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("contained credential material");

    expect(
      executeProviderNativeHttpTool(
        {
          ...baseInput,
          credential: { ...baseInput.credential, fields: { apiKey: "abc123" } },
        },
        {
          dnsLookup: PUBLIC_DNS,
          pinnedRequest: async () =>
            new Response(JSON.stringify({ token: "abc123" }), {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ).rejects.toThrow("contained credential material");

    expect(
      executeProviderNativeHttpTool(
        {
          ...baseInput,
          credential: { ...baseInput.credential, fields: { apiKey: "abc123" } },
        },
        {
          dnsLookup: PUBLIC_DNS,
          pinnedRequest: async () =>
            new Response(JSON.stringify({ message: "invalid key abc123" }), {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ).rejects.toThrow("contained credential material");

    expect(
      executeProviderNativeHttpTool(
        {
          ...baseInput,
          credential: { ...baseInput.credential, fields: { apiKey: "id" } },
        },
        {
          dnsLookup: PUBLIC_DNS,
          pinnedRequest: async () =>
            new Response(JSON.stringify({ id: "stats-1" }), {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ).resolves.toMatchObject({
      parsedBody: { id: "stats-1" },
      responseStatus: 200,
    });
  });

  test("distinguishes pre-dispatch failures from ambiguous mutation outcomes", async () => {
    const mutationInput = {
      credential: SENDGRID_CREDENTIAL,
      definition: definition("sendgrid.email.send"),
      input: SENDGRID_SEND_INPUT,
      request: {
        idempotencyKey: "run-1:sendgrid-mutation-failure",
        toolName: "sendgrid.email.send",
      },
    } as const;

    let preDispatchFailure: unknown;
    try {
      await executeProviderNativeHttpTool(mutationInput, {
        dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }],
        pinnedRequest: async () => new Response("{}"),
      });
    } catch (cause) {
      preDispatchFailure = cause;
    }
    expect(preDispatchFailure).toBeInstanceOf(ProviderNativeExecutionKnownFailureError);

    expect(
      executeProviderNativeHttpTool(mutationInput, {
        dnsLookup: PUBLIC_DNS,
        requestTimeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);

    let postDispatchFailure: unknown;
    try {
      await executeProviderNativeHttpTool(mutationInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(JSON.stringify({ error: "provider failure" }), {
            headers: { "content-type": "application/json" },
            status: 500,
          }),
      });
    } catch (cause) {
      postDispatchFailure = cause;
    }
    expect(postDispatchFailure).toBeInstanceOf(ProviderNativeExecutionOutcomeUnknownError);
    expect(postDispatchFailure).not.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);

    expect(
      executeProviderNativeHttpTool(mutationInput, {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () =>
          new Response(JSON.stringify({ error: "validation failed" }), {
            headers: { "content-type": "application/json" },
            status: 400,
          }),
      }),
    ).rejects.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);

    expect(
      executeProviderNativeHttpTool(mutationInput, {
        dnsLookup: PUBLIC_DNS,
        maxResponseBytes: 2,
        pinnedRequest: async () =>
          new Response("oversized", {
            headers: { "content-length": "9", "content-type": "text/plain" },
            status: 400,
          }),
      }),
    ).rejects.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);
  });
});
