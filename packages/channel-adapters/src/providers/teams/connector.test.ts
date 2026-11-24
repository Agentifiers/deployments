import { describe, expect, test } from "bun:test";

import {
  TeamsBotAuthenticationError,
  TeamsConnectorError,
  teamsConnectorClient,
} from "./connector.ts";
import { teamsBotCredentials, TeamsCredentialError } from "./credentials.ts";

const credentials = teamsBotCredentials({
  appId: "00000000-0000-4000-8000-000000000001",
  appPassword: "secret-password",
  appTenantId: "11111111-2222-4333-8444-555555555555",
});
const SERVICE_URL = "https://smba.trafficmanager.net/amer";
const CONVERSATION_ID = "19:general@thread.tacv2;messageid=1700000000001";
const activity = { text: "hello", textFormat: "markdown", type: "message" } as const;

interface RecordedRequest {
  readonly body: string;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function fakeConnector(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
  token: { expiresIn?: number } = {},
) {
  const requests: RecordedRequest[] = [];
  let tokenCount = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : String(input),
    };
    requests.push(request);
    if (request.url.startsWith("https://login.microsoftonline.com/")) {
      tokenCount += 1;
      return Response.json({
        access_token: `token-${String(tokenCount)}`,
        expires_in: token.expiresIn ?? 3_599,
        token_type: "Bearer",
      });
    }
    return respond(request);
  }) as typeof globalThis.fetch;
  return {
    connectorRequests: () => requests.filter((request) => !request.url.includes("login.")),
    fetch: fetchImpl,
    requests,
    tokenRequests: () => requests.filter((request) => request.url.includes("login.")),
  };
}

async function connectorError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TeamsConnectorError);
  return error as TeamsConnectorError;
}

describe("Teams credentials", () => {
  test("defaults the app tenant to the multi-tenant authority and validates values", () => {
    expect(teamsBotCredentials({ appId: " app-1 ", appPassword: "pw" })).toEqual({
      appId: "app-1",
      appPassword: "pw",
      appTenantId: "botframework.com",
    });
    expect(() => teamsBotCredentials({ appPassword: "pw" })).toThrow(TeamsCredentialError);
    expect(() => teamsBotCredentials({ appId: "app-1", appPassword: " " })).toThrow(
      TeamsCredentialError,
    );
    expect(() =>
      teamsBotCredentials({ appId: "app-1", appPassword: "pw", appTenantId: "../evil" }),
    ).toThrow(TeamsCredentialError);
  });
});

describe("Teams Bot Connector client", () => {
  test("acquires a client-credentials token once and posts to the conversation", async () => {
    const server = fakeConnector(() => Response.json({ id: "activity-1" }, { status: 201 }));
    const client = teamsConnectorClient({ fetch: server.fetch });
    expect(
      await client.sendActivity({
        activity,
        conversationId: CONVERSATION_ID,
        credentials,
        serviceUrl: SERVICE_URL,
      }),
    ).toEqual({ id: "activity-1" });
    await client.updateActivity({
      activity,
      activityId: "activity-1",
      conversationId: CONVERSATION_ID,
      credentials,
      serviceUrl: SERVICE_URL,
    });

    const [tokenRequest] = server.tokenRequests();
    expect(server.tokenRequests()).toHaveLength(1);
    expect(tokenRequest!.url).toBe(
      "https://login.microsoftonline.com/11111111-2222-4333-8444-555555555555/oauth2/v2.0/token",
    );
    expect(Object.fromEntries(new URLSearchParams(tokenRequest!.body))).toEqual({
      client_id: credentials.appId,
      client_secret: "secret-password",
      grant_type: "client_credentials",
      scope: "https://api.botframework.com/.default",
    });
    const [send, update] = server.connectorRequests();
    expect(send!.method).toBe("POST");
    expect(send!.url).toBe(
      `https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(CONVERSATION_ID)}/activities`,
    );
    expect(send!.headers.get("authorization")).toBe("Bearer token-1");
    expect(JSON.parse(send!.body)).toEqual(activity);
    expect(update!.method).toBe("PUT");
    expect(update!.url).toEndWith("/activities/activity-1");
    expect(JSON.parse(update!.body)).toEqual({ ...activity, id: "activity-1" });
  });

  test("renews the token five minutes before expiry and per credential secret", async () => {
    const server = fakeConnector(() => Response.json({ id: "a" }, { status: 201 }));
    let clock = 1_000_000;
    const client = teamsConnectorClient({ fetch: server.fetch, now: () => clock });
    const send = (botCredentials = credentials) =>
      client.sendActivity({
        activity,
        conversationId: "a:1",
        credentials: botCredentials,
        serviceUrl: SERVICE_URL,
      });
    await send();
    clock += (3_599 - 301) * 1_000;
    await send();
    expect(server.tokenRequests()).toHaveLength(1);
    clock += 2_000;
    await send();
    expect(server.tokenRequests()).toHaveLength(2);
    await send({ ...credentials, appPassword: "rotated-password" });
    expect(server.tokenRequests()).toHaveLength(3);
  });

  test("raises an authentication error when the token endpoint rejects the bot", async () => {
    const fetch = (async () =>
      Response.json(
        { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" },
        { status: 401 },
      )) as unknown as typeof globalThis.fetch;
    const error = await teamsConnectorClient({ fetch })
      .sendActivity({ activity, conversationId: "a:1", credentials, serviceUrl: SERVICE_URL })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TeamsBotAuthenticationError);
    expect((error as TeamsBotAuthenticationError).code).toBe("invalid_client");
    expect((error as Error).message).not.toContain("secret-password");
  });

  test("classifies connector failures", async () => {
    const cases: [Response, Partial<TeamsConnectorError>][] = [
      [
        Response.json(
          { error: { code: "ContentStreamNotAllowed", message: "Stream stopped" } },
          { status: 403 },
        ),
        {
          code: "ContentStreamNotAllowed",
          definitiveRejection: true,
          retryable: false,
          status: 403,
        },
      ],
      [
        Response.json({ error: { code: "BadArgument" } }, { status: 400 }),
        { code: "BadArgument", definitiveRejection: true, retryable: false, status: 400 },
      ],
      [
        new Response("", { status: 404 }),
        { definitiveRejection: true, retryable: false, status: 404 },
      ],
      [
        new Response("", { headers: { "retry-after": "2" }, status: 429 }),
        { definitiveRejection: false, retryable: true, status: 429 },
      ],
      [
        new Response("upstream", { status: 502 }),
        { definitiveRejection: false, retryable: true, status: 502 },
      ],
    ];
    for (const [response, expected] of cases) {
      const server = fakeConnector(() => response);
      const error = await connectorError(
        teamsConnectorClient({ fetch: server.fetch }).sendActivity({
          activity,
          conversationId: "a:1",
          credentials,
          serviceUrl: SERVICE_URL,
        }),
      );
      expect(error).toMatchObject({ ...expected, stage: "connector" });
      if (!expected.code) expect(error.code).toBeUndefined();
    }
  });

  test("treats network failures and timeouts as retryable without a status", async () => {
    const network = fakeConnector(() => {
      throw new TypeError("fetch failed");
    });
    const networkError = await connectorError(
      teamsConnectorClient({ fetch: network.fetch }).sendActivity({
        activity,
        conversationId: "a:1",
        credentials,
        serviceUrl: SERVICE_URL,
      }),
    );
    expect(networkError).toMatchObject({ definitiveRejection: false, retryable: true });
    expect(networkError.status).toBeUndefined();

    const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((input instanceof Request ? input.url : String(input)).includes("login.")) {
        return Response.json({ access_token: "token", expires_in: 3_599 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as typeof globalThis.fetch;
    const timeoutError = await connectorError(
      teamsConnectorClient({ fetch: slowFetch, timeoutMs: 20 }).sendActivity({
        activity,
        conversationId: "a:1",
        credentials,
        serviceUrl: SERVICE_URL,
      }),
    );
    expect(timeoutError).toMatchObject({ definitiveRejection: false, retryable: true });
    expect(timeoutError.message).toContain("timed out");
  });

  test("marks token endpoint failures as authentication-stage so no activity was sent", async () => {
    const requests: string[] = [];
    const failing = (respond: () => Response | Promise<Response>) =>
      (async (input: string | URL | Request) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return respond();
      }) as typeof globalThis.fetch;
    const send = (fetchImpl: typeof globalThis.fetch) =>
      connectorError(
        teamsConnectorClient({ fetch: fetchImpl }).sendActivity({
          activity,
          conversationId: "a:1",
          credentials,
          serviceUrl: SERVICE_URL,
        }),
      );
    expect(await send(failing(() => new Response("", { status: 503 })))).toMatchObject({
      retryable: true,
      stage: "authentication",
      status: 503,
    });
    expect(
      await send(
        failing(() => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).toMatchObject({ retryable: true, stage: "authentication" });
    expect(await send(failing(() => Response.json({ token_type: "Bearer" })))).toMatchObject({
      retryable: false,
      stage: "authentication",
    });
    expect(requests.every((url) => url.startsWith("https://login.microsoftonline.com/"))).toBe(
      true,
    );

    const network = fakeConnector(() => {
      throw new TypeError("fetch failed");
    });
    expect(
      await connectorError(
        teamsConnectorClient({ fetch: network.fetch }).sendActivity({
          activity,
          conversationId: "a:1",
          credentials,
          serviceUrl: SERVICE_URL,
        }),
      ),
    ).toMatchObject({ retryable: true, stage: "connector" });
  });

  test("drops a rejected bot token so the retry re-authenticates", async () => {
    let attempts = 0;
    const server = fakeConnector(() => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 401 })
        : Response.json({ id: "after-reauth" }, { status: 201 });
    });
    const client = teamsConnectorClient({ fetch: server.fetch });
    const input = { activity, conversationId: "a:1", credentials, serviceUrl: SERVICE_URL };
    expect(await connectorError(client.sendActivity(input))).toMatchObject({
      retryable: true,
      status: 401,
    });
    expect(await client.sendActivity(input)).toEqual({ id: "after-reauth" });
    expect(server.tokenRequests()).toHaveLength(2);
    expect(server.connectorRequests()[1]!.headers.get("authorization")).toBe("Bearer token-2");
  });

  test("refuses service URLs outside the Teams connector before sending credentials", async () => {
    const server = fakeConnector(() => Response.json({ id: "x" }, { status: 201 }));
    const client = teamsConnectorClient({ fetch: server.fetch });
    for (const serviceUrl of [
      "https://evil.example/teams/",
      "http://smba.trafficmanager.net/teams/",
      "https://smba.trafficmanager.net.evil.example/teams/",
      "https://user:pw@smba.trafficmanager.net/teams/",
    ]) {
      expect(
        client.sendActivity({ activity, conversationId: "a:1", credentials, serviceUrl }),
      ).rejects.toThrow(TypeError);
    }
    expect(server.requests).toHaveLength(0);
  });
});
