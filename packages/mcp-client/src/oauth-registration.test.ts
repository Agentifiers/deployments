import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";
import {
  registerDynamicOAuthClient,
  type DynamicOAuthClientMetadata,
  type McpClientRegistrationError,
} from "./index.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];
const ENDPOINT = "https://auth.vendor.example/register";
const CALLBACK = "https://channel.deployments.ai/public/provider-connections/oauth/callback/notion";

const METADATA: DynamicOAuthClientMetadata = {
  application_type: "web",
  client_name: "Deployments.ai",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [CALLBACK],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_basic",
};

function register(respond: (request: ExecutePinnedHttpRequestOptions) => Response) {
  const requests: ExecutePinnedHttpRequestOptions[] = [];
  const result = registerDynamicOAuthClient({
    dnsLookup: PUBLIC_DNS,
    metadata: METADATA,
    pinnedRequest: async (request) => {
      requests.push(request);
      return respond(request);
    },
    registrationEndpoint: ENDPOINT,
  });
  return { requests, result };
}

const json = (value: unknown, status: number) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });

describe("registerDynamicOAuthClient", () => {
  test("posts RFC 7591 metadata and parses the issued client", async () => {
    const { requests, result } = register(() =>
      json(
        {
          client_id: "client-123",
          client_id_issued_at: 1_790_000_000,
          client_secret: "s3cret",
          client_secret_expires_at: 0,
          redirect_uris: [CALLBACK, "https://other.example/cb"],
          registration_client_uri: "https://auth.vendor.example/register/client-123",
          token_endpoint_auth_method: "client_secret_basic",
        },
        201,
      ),
    );

    expect(await result).toEqual({
      clientId: "client-123",
      clientSecret: "s3cret",
      clientSecretExpiresAt: 0,
      registrationClientUri: "https://auth.vendor.example/register/client-123",
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.toString()).toBe(ENDPOINT);
    expect(requests[0]?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(requests[0]?.body))).toEqual(METADATA);
  });

  test("accepts 200, defaults the auth method to the requested one, and allows public clients", async () => {
    const publicClient = registerDynamicOAuthClient({
      dnsLookup: PUBLIC_DNS,
      metadata: { ...METADATA, token_endpoint_auth_method: "none" },
      pinnedRequest: async () => json({ client_id: "public-1" }, 200),
      registrationEndpoint: ENDPOINT,
    });
    expect(await publicClient).toEqual({ clientId: "public-1", tokenEndpointAuthMethod: "none" });
  });

  test("rejects invalid success bodies without echoing credentials", async () => {
    const cases: readonly [unknown, string][] = [
      [{ client_secret: "leaked-secret" }, "did not include client_id"],
      [
        {
          client_id: "c",
          client_secret: "leaked-secret",
          redirect_uris: ["https://evil.example/cb"],
        },
        "redirect URIs",
      ],
      [{ client_id: "c" }, "without a client secret"],
      [
        { client_id: "c", client_secret: "leaked-secret", client_secret_expires_at: -1 },
        "client_secret_expires_at",
      ],
    ];
    for (const [body, message] of cases) {
      const error = await register(() => json(body, 201)).result.catch((cause: unknown) => cause);
      expect(error).toMatchObject({ name: "McpClientRegistrationError", status: 201 });
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("leaked-secret");
    }
  });

  test("surfaces HTTP status and a bounded OAuth error code only", async () => {
    expect(
      register(() =>
        json({ error: "invalid_redirect_uri", error_description: "secret detail s3cret" }, 400),
      ).result,
    ).rejects.toMatchObject({
      message: "Dynamic client registration failed with HTTP 400 (invalid_redirect_uri).",
      oauthError: "invalid_redirect_uri",
      status: 400,
    } satisfies Partial<McpClientRegistrationError>);

    const hostile = await register(() =>
      json({ error: `bad"${"x".repeat(100)}` }, 403),
    ).result.catch((cause: unknown) => cause);
    expect(hostile).toMatchObject({ status: 403 });
    expect((hostile as McpClientRegistrationError).oauthError).toBeUndefined();
  });

  test("refuses non-HTTPS endpoints, redirects, and oversized responses", async () => {
    let requested = false;
    expect(
      registerDynamicOAuthClient({
        dnsLookup: PUBLIC_DNS,
        metadata: METADATA,
        pinnedRequest: async () => {
          requested = true;
          return json({}, 201);
        },
        registrationEndpoint: "http://auth.vendor.example/register",
      }),
    ).rejects.toThrow("must be an absolute HTTPS URL");
    expect(requested).toBe(false);

    expect(
      register(() => new Response(null, { headers: { location: "/elsewhere" }, status: 307 }))
        .result,
    ).rejects.toThrow("redirected");
    expect(
      register(() => json({ client_id: "c", padding: "x".repeat(70_000) }, 201)).result,
    ).rejects.toThrow("too large");
  });
});
