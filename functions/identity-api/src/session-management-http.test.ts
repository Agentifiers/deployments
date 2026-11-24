import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { makeIdentityHttpHandler, type RestApiEvent, type RestApiResponse } from "./http.ts";
import {
  browserSession,
  identityApplication,
  memoryIdentityStore,
  principalSeed,
} from "./session-management.fixture.ts";

const PRINCIPAL_A = "01ARZ3NDEKTSV4RRFFQ69G5FA0" as Ulid;
const PRINCIPAL_B = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const CURRENT = "01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ulid;
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid;
const FOREIGN = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const UI_ORIGIN = "https://auth.deployments.ai";

function handler() {
  const sessions = [
    browserSession({
      createdAt: "2026-07-28T00:10:00.000Z",
      id: CURRENT,
      principalId: PRINCIPAL_A,
      rawToken: "token-current",
    }),
    browserSession({
      createdAt: "2026-07-28T00:20:00.000Z",
      id: OTHER,
      principalId: PRINCIPAL_A,
      rawToken: "token-other",
    }),
    browserSession({
      createdAt: "2026-07-28T00:30:00.000Z",
      id: FOREIGN,
      principalId: PRINCIPAL_B,
      rawToken: "token-foreign",
    }),
  ];
  const store = memoryIdentityStore([
    ...principalSeed(PRINCIPAL_A),
    ...principalSeed(PRINCIPAL_B),
    ...sessions.flatMap(({ locator, session }) => [locator, session]),
  ]);
  const application = identityApplication(store.repository);
  return {
    application,
    handle: makeIdentityHttpHandler(application, {
      applicationOrigin: "https://app.deployments.ai",
      issuer: UI_ORIGIN,
      publicResponseMinimumMs: 0,
      queuePublicEmailRequest: async () => undefined,
      registrationEnabled: true,
      secureCookies: true,
      uiOrigin: UI_ORIGIN,
    }),
  };
}

function request(
  method: string,
  path: string,
  options: {
    readonly csrf?: boolean;
    readonly query?: Record<string, string>;
    readonly token?: string;
  } = {},
): RestApiEvent {
  const cookies = [
    ...(options.token ? [`__Host-dpl_identity=${options.token}`] : []),
    ...(options.csrf ? ["__Host-dpl_csrf=csrf-value"] : []),
  ];
  return {
    headers: {
      ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
      ...(options.csrf ? { origin: UI_ORIGIN, "x-csrf-token": "csrf-value" } : {}),
    },
    httpMethod: method,
    path,
    ...(options.query ? { queryStringParameters: options.query } : {}),
  };
}

async function listedIds(handle: (event: RestApiEvent) => Promise<RestApiResponse>, token: string) {
  const response = await handle(request("GET", "/v1/auth/sessions", { token }));
  return (JSON.parse(response.body) as { items: { id: string; current: boolean }[] }).items;
}

describe("session management HTTP", () => {
  test("lists the caller's sessions without caching and rejects missing cookies", async () => {
    const { handle } = handler();

    const listed = await handle(request("GET", "/v1/auth/sessions", { token: "token-current" }));
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(listed.body)).toMatchObject({
      items: [
        { current: false, id: OTHER },
        { current: true, id: CURRENT },
      ],
    });
    expect(listed.body).not.toContain("tokenHash");
    expect(listed.body).not.toContain(FOREIGN);

    const anonymous = await handle(request("GET", "/v1/auth/sessions"));
    expect(anonymous.statusCode).toBe(401);
    expect(JSON.parse(anonymous.body)).toEqual({ error: "unauthorized" });

    for (const query of [{ limit: "abc" }, { limit: "0" }, { cursor: "%%%" }]) {
      const rejected = await handle(
        request("GET", "/v1/auth/sessions", { query, token: "token-current" }),
      );
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body)).toMatchObject({ error: "invalid_request" });
    }
  });

  test("requires the origin and CSRF guard before revoking", async () => {
    const { application, handle } = handler();

    const forged = await handle(
      request("DELETE", `/v1/auth/sessions/${OTHER}`, { token: "token-current" }),
    );

    expect(forged.statusCode).toBe(403);
    expect(await application.session("token-other")).toMatchObject({ sessionId: OTHER });
  });

  test("revokes another of the caller's sessions and keeps the current cookie", async () => {
    const { application, handle } = handler();

    const revoked = await handle(
      request("DELETE", `/v1/auth/sessions/${OTHER}`, { csrf: true, token: "token-current" }),
    );

    expect(revoked.statusCode).toBe(204);
    expect(revoked.multiValueHeaders).toBeUndefined();
    expect(await application.session("token-other")).toBeUndefined();
    expect((await listedIds(handle, "token-current")).map((item) => item.id)).toEqual([CURRENT]);
  });

  test("hides another principal's session behind 404 and leaves it active", async () => {
    const { application, handle } = handler();

    const response = await handle(
      request("DELETE", `/v1/auth/sessions/${FOREIGN}`, { csrf: true, token: "token-current" }),
    );

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "not_found" });
    expect(await application.session("token-foreign")).toMatchObject({ sessionId: FOREIGN });
  });

  test("clears the cookie when the current session is revoked and rejects anonymous deletes", async () => {
    const { application, handle } = handler();

    const anonymous = await handle(request("DELETE", `/v1/auth/sessions/${OTHER}`, { csrf: true }));
    expect(anonymous.statusCode).toBe(401);

    const revoked = await handle(
      request("DELETE", `/v1/auth/sessions/${CURRENT}`, { csrf: true, token: "token-current" }),
    );
    expect(revoked.statusCode).toBe(204);
    expect(revoked.multiValueHeaders?.["Set-Cookie"]?.[0]).toStartWith("__Host-dpl_identity=;");
    expect(revoked.multiValueHeaders?.["Set-Cookie"]?.[0]).toContain("Max-Age=0");
    expect(await application.session("token-current")).toBeUndefined();
  });
});
