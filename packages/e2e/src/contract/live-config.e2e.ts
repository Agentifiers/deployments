import { expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import {
  credentialedE2eConfig,
  privilegedIdentityAccessToken,
  safeJwtMetadata,
  slackIdentityE2eConfig,
} from "../harness/live-config.ts";

const CONFIGURATION_NAMES = [
  "DEPLOYMENTS_E2E_API_URL",
  "DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE",
  "DEPLOYMENTS_E2E_ORGANIZATION_ID",
  "DEPLOYMENTS_E2E_PLATFORM_API_KEY",
  "DEPLOYMENTS_E2E_PLATFORM_API_KEY_FILE",
  "DEPLOYMENTS_E2E_IDENTITY_CLIENT_SECRET",
  "DEPLOYMENTS_E2E_IDENTITY_ISSUER",
  "DEPLOYMENTS_E2E_IDENTITY_PASSWORD",
  "DEPLOYMENTS_E2E_IDENTITY_USERNAME",
  "DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL",
  "DEPLOYMENTS_E2E_CHANNEL_API_URL",
  "DEPLOYMENTS_E2E_ENVIRONMENT_ID",
  "DEPLOYMENTS_E2E_PROJECT_ID",
  "DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME",
  "DEPLOYMENTS_E2E_SLACK_BOT_TOKEN",
  "DEPLOYMENTS_E2E_SLACK_CHANNEL_ID",
  "DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET",
  "DEPLOYMENTS_E2E_SLACK_TEAM_ID",
  "DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID",
  "DEPLOYMENTS_E2E_SLACK_USER_ID",
  "DEPLOYMENTS_E2E_SLACK_USER_TOKEN",
] as const;

function jsonBody(request: RequestInit | undefined): unknown {
  const body = request?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body);
}

function configureSlackIdentityE2e(channelApiUrl: string, acknowledgedUrl?: string) {
  process.env.DEPLOYMENTS_E2E_API_URL = "https://api.example.test";
  process.env.DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE = "https://api.example.test";
  process.env.DEPLOYMENTS_E2E_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  process.env.DEPLOYMENTS_E2E_PLATFORM_API_KEY = "platform-key";
  process.env.DEPLOYMENTS_E2E_PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  process.env.DEPLOYMENTS_E2E_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
  process.env.DEPLOYMENTS_E2E_CHANNEL_API_URL = channelApiUrl;
  if (acknowledgedUrl) process.env.DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL = acknowledgedUrl;
  process.env.DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME = "E2E Agent";
  process.env.DEPLOYMENTS_E2E_SLACK_BOT_TOKEN = "xoxb-secret";
  process.env.DEPLOYMENTS_E2E_SLACK_CHANNEL_ID = "C0123456789";
  process.env.DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET = "signing-secret";
  process.env.DEPLOYMENTS_E2E_SLACK_TEAM_ID = "T0123456789";
  process.env.DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID = "S0123456789";
  process.env.DEPLOYMENTS_E2E_SLACK_USER_ID = "U0123456789";
  process.env.DEPLOYMENTS_E2E_SLACK_USER_TOKEN = "xoxp-secret";
}

it("reports only non-secret JWT verification metadata", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  expect(
    safeJwtMetadata(
      `${encode({ alg: "RS256", kid: "key-1", typ: "JWT" })}.${encode({
        aud: "https://api.example.test",
        client_id: "deployments-cli",
        exp: 20,
        iat: 10,
        iss: "https://auth.example.test",
        jti: "must-not-leak",
        nbf: 10,
        sid: "must-not-leak",
        sub: "must-not-leak",
      })}.signature`,
    ),
  ).toBe(
    JSON.stringify({
      alg: "RS256",
      aud: "https://api.example.test",
      client_id: "deployments-cli",
      exp: 20,
      iat: 10,
      iss: "https://auth.example.test",
      kid: "key-1",
      nbf: 10,
      typ: "JWT",
    }),
  );
  expect(safeJwtMetadata("opaque-secret")).toBe("non-jwt");
  expect(safeJwtMetadata("a.b.c")).toBe("malformed-jwt");
});

it.effect("uses the confidential web client for privileged E2E scopes", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const fetchMock = vi.fn(async (url: string | URL, request?: RequestInit) => {
        const target = new URL(String(url));
        if (target.pathname === "/sign-in") {
          return new Response("<!doctype html>", {
            headers: { "set-cookie": "__Host-dpl_csrf=csrf-value; Path=/; Secure" },
            status: 200,
          });
        }
        if (target.pathname === "/v1/auth/sign-in") {
          return new Response(JSON.stringify({ principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }), {
            headers: {
              "set-cookie": "__Host-dpl_identity=session-value; Path=/; Secure; HttpOnly",
            },
            status: 200,
          });
        }
        if (target.pathname === "/oauth2/authorize") {
          expect(target.searchParams.get("client_id")).toBe("deployments-e2e");
          expect(target.searchParams.get("scope")).toContain("managed-skills:admin");
          expect(target.searchParams.get("scope")).toContain("memory:execute");
          const callback = new URL("https://app.example.test/auth/callback");
          callback.searchParams.set("code", "authorization-code");
          callback.searchParams.set("state", target.searchParams.get("state")!);
          return new Response(null, { headers: { location: callback.toString() }, status: 302 });
        }
        if (target.pathname === "/oauth2/token") {
          expect(request?.headers).toMatchObject({
            authorization: `Basic ${Buffer.from("deployments-e2e:client-secret").toString("base64")}`,
          });
          const form = request?.body;
          if (!(form instanceof URLSearchParams)) {
            throw new Error("Expected a form-encoded token request body");
          }
          expect(form.get("grant_type")).toBe("authorization_code");
          expect(form.get("code")).toBe("authorization-code");
          return new Response(
            JSON.stringify({ access_token: "privileged.access.token", expires_in: 600 }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${target.toString()}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }),
    () =>
      privilegedIdentityAccessToken({
        clientSecret: "client-secret",
        issuer: "https://auth.example.test",
        password: "password",
        redirectUri: "https://app.example.test/auth/callback",
        username: "e2e@example.com",
      }).pipe(
        Effect.tap((issued) =>
          Effect.sync(() => {
            expect(issued.token).toBe("privileged.access.token");
            expect(issued.expiresAtMs - issued.issuedAtMs).toBe(600_000);
          }),
        ),
      ),
    () => Effect.sync(() => vi.unstubAllGlobals()),
  ),
);

it.effect(
  "approves a platform device grant without putting identity credentials in configuration",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.fromEntries(
          CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
        );
        for (const name of CONFIGURATION_NAMES) delete process.env[name];
        process.env.DEPLOYMENTS_E2E_API_URL = "https://api.example.test";
        process.env.DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE = "https://api.example.test";
        process.env.DEPLOYMENTS_E2E_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        process.env.DEPLOYMENTS_E2E_IDENTITY_ISSUER = "https://auth.example.test";
        process.env.DEPLOYMENTS_E2E_IDENTITY_PASSWORD = "identity-test-password";
        process.env.DEPLOYMENTS_E2E_IDENTITY_USERNAME = "e2e@example.com";
        const fetchMock = vi.fn(async (url: string | URL, request?: RequestInit) => {
          const href = String(url);
          if (href === "https://api.example.test/v1/device-authorizations") {
            return new Response(
              JSON.stringify({
                deviceCode: "device-code",
                expiresIn: 600,
                interval: 5,
                userCode: "ABCD-EFGH",
                verificationUri: "https://app.example.test/device",
                verificationUriComplete: "https://app.example.test/device?code=ABCD-EFGH",
              }),
              { status: 200 },
            );
          }
          if (href === "https://auth.example.test/sign-in") {
            return new Response("<!doctype html>", {
              headers: { "set-cookie": "__Host-dpl_csrf=csrf-value; Path=/; Secure" },
              status: 200,
            });
          }
          if (href === "https://auth.example.test/v1/auth/sign-in") {
            expect(jsonBody(request)).toEqual({
              email: "e2e@example.com",
              password: "identity-test-password",
            });
            return new Response(JSON.stringify({ principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }), {
              headers: {
                "set-cookie": "__Host-dpl_identity=session-value; Path=/; Secure; HttpOnly",
              },
              status: 200,
            });
          }
          if (href === "https://auth.example.test/v1/device/claim") {
            expect(jsonBody(request)).toEqual({ userCode: "ABCD-EFGH" });
            return new Response(JSON.stringify({ clientId: "deployments-cli" }), { status: 200 });
          }
          if (href === "https://auth.example.test/v1/device/approve") {
            return new Response(null, { status: 204 });
          }
          if (href === "https://api.example.test/v1/device-authorizations/token") {
            return new Response(
              JSON.stringify({
                bearerToken: "platform.access.token",
                expiresIn: 900,
                tokenType: "Bearer",
              }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected fetch: ${href}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        return { fetchMock, previous };
      }),
      ({ fetchMock }) =>
        Effect.gen(function* () {
          const config = yield* credentialedE2eConfig;
          expect(config.platformCredential.token).toBe("platform.access.token");
          expect(fetchMock).toHaveBeenCalledTimes(6);
        }),
      ({ previous }) =>
        Effect.sync(() => {
          vi.unstubAllGlobals();
          for (const name of CONFIGURATION_NAMES) {
            const value = previous[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }),
    ),
);

it.effect("rejects destructive credentialed tests against an unacknowledged target", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
      );
      for (const name of CONFIGURATION_NAMES) delete process.env[name];
      process.env.DEPLOYMENTS_E2E_API_URL = "https://api.us.deployments.ai";
      process.env.DEPLOYMENTS_E2E_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      process.env.DEPLOYMENTS_E2E_PLATFORM_API_KEY = "production-key-must-not-be-used";
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        const result = yield* credentialedE2eConfig.pipe(
          Effect.map((config) => ({ config, ok: true as const })),
          Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("Credentialed E2E is destructive");
          expect(result.error.message).toContain("DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE");
        }
      }),
    (previous) =>
      Effect.sync(() => {
        for (const name of CONFIGURATION_NAMES) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  ),
);

it.effect("requires an exact target value to acknowledge destructive tests", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
      );
      for (const name of CONFIGURATION_NAMES) delete process.env[name];
      process.env.DEPLOYMENTS_E2E_API_URL = "https://staging.example.test";
      process.env.DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE = "https://staging.example.test";
      process.env.DEPLOYMENTS_E2E_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      process.env.DEPLOYMENTS_E2E_PLATFORM_API_KEY = "acknowledged-test-key";
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        const config = yield* credentialedE2eConfig;
        expect(config.apiUrl).toBe("https://staging.example.test");
      }),
    (previous) =>
      Effect.sync(() => {
        for (const name of CONFIGURATION_NAMES) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  ),
);

it.effect("rejects an unapproved Slack channel API credential destination", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
      );
      for (const name of CONFIGURATION_NAMES) delete process.env[name];
      configureSlackIdentityE2e(
        "https://credentials.example.test",
        "https://credentials.example.test",
      );
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        const result = yield* slackIdentityE2eConfig.pipe(
          Effect.map((config) => ({ config, ok: true as const })),
          Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("credential-free HTTPS API Gateway origin");
          expect(result.error.message).toContain("DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL");
        }
      }),
    (previous) =>
      Effect.sync(() => {
        for (const name of CONFIGURATION_NAMES) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  ),
);

it.effect("accepts an explicitly approved development API Gateway channel origin", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
      );
      for (const name of CONFIGURATION_NAMES) delete process.env[name];
      const channelApiUrl = "https://abc123.execute-api.us-east-2.amazonaws.com";
      configureSlackIdentityE2e(channelApiUrl, channelApiUrl);
      return previous;
    }),
    () =>
      Effect.gen(function* () {
        const config = yield* slackIdentityE2eConfig;
        expect(config.slackChannelApiUrl).toBe(
          "https://abc123.execute-api.us-east-2.amazonaws.com",
        );
      }),
    (previous) =>
      Effect.sync(() => {
        for (const name of CONFIGURATION_NAMES) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  ),
);

it.effect(
  "requires a distinct Slack user token for user-group management and reply observation",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Object.fromEntries(
          CONFIGURATION_NAMES.map((name) => [name, process.env[name]]),
        );
        for (const name of CONFIGURATION_NAMES) delete process.env[name];
        const channelApiUrl = "https://abc123.execute-api.us-east-2.amazonaws.com";
        configureSlackIdentityE2e(channelApiUrl, channelApiUrl);
        process.env.DEPLOYMENTS_E2E_SLACK_USER_TOKEN = process.env.DEPLOYMENTS_E2E_SLACK_BOT_TOKEN;
        return previous;
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* slackIdentityE2eConfig.pipe(
            Effect.map((config) => ({ config, ok: true as const })),
            Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
          );
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.message).toContain(
              "distinct xoxb bot and xoxp user tokens for user-group management",
            );
          }
        }),
      (previous) =>
        Effect.sync(() => {
          for (const name of CONFIGURATION_NAMES) {
            const value = previous[name];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }),
    ),
);
