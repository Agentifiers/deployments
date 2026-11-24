import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";

import {
  executeProviderNativeHttpTool,
  ProviderNativeExecutionKnownFailureError,
  ProviderNativeExecutionOutcomeUnknownError,
  ProviderNativeExecutionRetryableError,
} from "../executor.ts";
import { microsoftTeamsNativeHttpToolDefinitions } from "./microsoft-teams.ts";

const ALL_SCOPES = [
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "Team.ReadBasic.All",
  "User.ReadBasic.All",
];
const TEAM_ID = "11111111-2222-3333-4444-555555555555";
const CHANNEL_ID = "19:general@thread.tacv2";
const CHANNEL_PATH = `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels/19%3Ageneral%40thread.tacv2`;

function definition(name: string) {
  const value = microsoftTeamsNativeHttpToolDefinitions.find((entry) => entry.toolName === name);
  if (!value) throw new Error(`Missing Microsoft Teams definition ${name}.`);
  return value;
}

async function run(
  toolName: string,
  input: Record<string, unknown>,
  respond: (request: ExecutePinnedHttpRequestOptions) => Response,
  grantedScopes: readonly string[] = ALL_SCOPES,
) {
  const requests: ExecutePinnedHttpRequestOptions[] = [];
  const result = executeProviderNativeHttpTool(
    {
      credential: {
        externalAccountId: "user-object-id",
        fields: { accessToken: "graph-secret-token-123456" },
        grantedScopes,
        provider: "microsoft_teams",
      },
      definition: definition(toolName),
      input,
      request: { idempotencyKey: `run-1:${toolName}`, toolName },
    },
    {
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: async (request) => {
        requests.push(request);
        return respond(request);
      },
      sleep: async () => {},
    },
  );
  return { requests, result };
}

const graphError = (status: number, code: string) =>
  Response.json({ error: { code, message: "Denied." } }, { status });

describe("Microsoft Teams provider-native tools", () => {
  test("maps team, channel, and thread reads to Graph v1.0 URLs", async () => {
    const urls: string[] = [];
    for (const [toolName, input] of [
      ["microsoft_teams.teams.list", {}],
      ["microsoft_teams.channels.list", { membershipType: "private", teamId: TEAM_ID }],
      [
        "microsoft_teams.messages.list",
        {
          channelId: CHANNEL_ID,
          cursor: `${CHANNEL_PATH}/messages?%24top=50&%24skiptoken=page-2`,
          includeReplies: true,
          limit: 500,
          teamId: TEAM_ID,
        },
      ],
      [
        "microsoft_teams.messages.replies",
        { channelId: CHANNEL_ID, cursor: "page-3", messageId: "1721609600123", teamId: TEAM_ID },
      ],
    ] as const) {
      const { requests, result } = await run(toolName, input, () => Response.json({ value: [] }));
      expect(result).resolves.toMatchObject({
        provider: "microsoft_teams",
        requestHost: "graph.microsoft.com",
      });
      expect(requests[0]?.headers?.authorization).toBe("Bearer graph-secret-token-123456");
      urls.push(String(requests[0]?.url));
    }
    expect(urls).toEqual([
      "https://graph.microsoft.com/v1.0/me/joinedTeams",
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels?%24filter=membershipType+eq+%27private%27`,
      `${CHANNEL_PATH}/messages?%24top=50&%24expand=replies&%24skiptoken=page-2`,
      `${CHANNEL_PATH}/messages/1721609600123/replies?%24top=20&%24skiptoken=page-3`,
    ]);
    expect(() =>
      definition("microsoft_teams.messages.list").buildUrl(
        {
          channelId: CHANNEL_ID,
          cursor: "https://evil.example/next?$skiptoken=x",
          teamId: TEAM_ID,
        },
        { externalAccountId: "user", provider: "microsoft_teams", token: "secret" },
        { idempotencyKey: "read", toolName: "microsoft_teams.messages.list" },
      ),
    ).toThrow("Microsoft Graph nextLink");
  });

  test("looks up users by id or UPN and by escaped email filter", () => {
    const lookup = definition("microsoft_teams.users.lookup");
    const token = { externalAccountId: "user", provider: "microsoft_teams", token: "secret" };
    const request = { idempotencyKey: "read", toolName: "microsoft_teams.users.lookup" };
    expect(lookup.buildUrl({ userId: "pat@contoso.com" }, token, request)).toBe(
      "https://graph.microsoft.com/v1.0/users/pat%40contoso.com",
    );
    expect(lookup.buildUrl({ email: "o'neil@contoso.com" }, token, request)).toBe(
      "https://graph.microsoft.com/v1.0/users?%24filter=mail+eq+%27o%27%27neil%40contoso.com%27&%24top=1",
    );
  });

  test("checks input-specific user scopes before dispatch", async () => {
    const lookup = definition("microsoft_teams.users.lookup");
    expect(lookup.requiredScopes).toEqual([]);
    expect(lookup.requiredScopesForInput?.({ email: "pat@contoso.com" })).toEqual([
      "User.ReadBasic.All",
    ]);
    expect(() => lookup.requiredScopesForInput?.({ email: "a@b.c", userId: "id" })).toThrow(
      "Exactly one of email or userId is required.",
    );
    expect(() => lookup.requiredScopesForInput?.({})).toThrow(
      "Exactly one of email or userId is required.",
    );
    const { requests, result } = await run(
      "microsoft_teams.users.lookup",
      { userId: "user-object-id" },
      () => Response.json({ id: "user-object-id" }),
      ["Team.ReadBasic.All"],
    );
    expect(result).rejects.toThrow("input-specific scopes");
    expect(requests).toHaveLength(0);
  });

  test("classifies Graph failures like Slack ok:false rejections", async () => {
    const forbidden = await run("microsoft_teams.channels.list", { teamId: TEAM_ID }, () =>
      graphError(403, "Forbidden"),
    );
    expect(forbidden.result).rejects.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);

    const throttled = await run("microsoft_teams.teams.list", {}, () =>
      graphError(429, "TooManyRequests"),
    );
    expect(throttled.result).rejects.toBeInstanceOf(ProviderNativeExecutionRetryableError);
    expect(throttled.requests).toHaveLength(3);

    const envelope = await run("microsoft_teams.teams.list", {}, () =>
      Response.json({ error: { code: "InvalidAuthenticationToken" } }),
    );
    expect(envelope.result).rejects.toThrow(
      "Microsoft Teams rejected the request: InvalidAuthenticationToken.",
    );

    const missing = await run("microsoft_teams.users.lookup", { email: "ghost@contoso.com" }, () =>
      Response.json({ value: [] }),
    );
    expect(missing.result).rejects.toThrow("Microsoft Teams user was not found.");

    const rejectedPost = await run(
      "microsoft_teams.post_message",
      { channelId: CHANNEL_ID, teamId: TEAM_ID, text: "Hi" },
      () => graphError(400, "BadRequest"),
    );
    expect(rejectedPost.result).rejects.toBeInstanceOf(ProviderNativeExecutionKnownFailureError);
    expect(rejectedPost.requests).toHaveLength(1);

    const ambiguousPost = await run(
      "microsoft_teams.post_message",
      { channelId: CHANNEL_ID, teamId: TEAM_ID, text: "Hi" },
      () => graphError(503, "ServiceUnavailable"),
    );
    expect(ambiguousPost.result).rejects.toBeInstanceOf(ProviderNativeExecutionOutcomeUnknownError);
    expect(ambiguousPost.requests).toHaveLength(1);
  });

  test("posts plain text messages and thread replies", async () => {
    const root = await run(
      "microsoft_teams.post_message",
      { channelId: CHANNEL_ID, subject: "Deploy", teamId: TEAM_ID, text: "Deployment complete" },
      () => Response.json({ id: "1721609600999" }, { status: 201 }),
    );
    expect(root.result).resolves.toMatchObject({
      externalOperationId: "1721609600999",
      outputSummary: "Posted a Microsoft Teams message.",
    });
    expect(String(root.requests[0]?.url)).toBe(`${CHANNEL_PATH}/messages`);
    expect(JSON.parse(String(root.requests[0]?.body))).toEqual({
      body: { content: "Deployment complete", contentType: "text" },
      subject: "Deploy",
    });

    const reply = await run(
      "microsoft_teams.post_message",
      { channelId: CHANNEL_ID, replyToMessageId: "1721609600123", teamId: TEAM_ID, text: "Done" },
      () => Response.json({ id: "1721609600998" }, { status: 201 }),
    );
    expect(reply.result).resolves.toMatchObject({
      outputSummary: "Posted a Microsoft Teams thread reply.",
    });
    expect(String(reply.requests[0]?.url)).toBe(`${CHANNEL_PATH}/messages/1721609600123/replies`);
    expect(() =>
      definition("microsoft_teams.post_message").buildBody?.(
        { channelId: CHANNEL_ID, replyToMessageId: "1", subject: "x", teamId: TEAM_ID, text: "y" },
        { externalAccountId: "user", provider: "microsoft_teams", token: "secret" },
        { idempotencyKey: "write", toolName: "microsoft_teams.post_message" },
      ),
    ).toThrow("subject is only supported on new channel messages");
  });

  test("renders data visualizations as Adaptive Card chart attachments", () => {
    const body = definition("microsoft_teams.post_message").buildBody?.(
      {
        channelId: CHANNEL_ID,
        dataVisualizations: [
          {
            chart: {
              segments: [
                { label: "Passed", value: 9 },
                { label: "Failed", value: 1 },
              ],
              type: "pie",
            },
            title: "Checks",
          },
          { chart: { segments: [], type: "pie" }, title: "Dropped" },
        ],
        teamId: TEAM_ID,
        text: "Results <b>& notes</b>\nSee chart",
      },
      { externalAccountId: "user", provider: "microsoft_teams", token: "secret" },
      { idempotencyKey: "write", toolName: "microsoft_teams.post_message" },
    );
    if (typeof body?.body !== "string") throw new Error("Expected a JSON string request body.");
    const payload = JSON.parse(body.body) as {
      attachments: { content: string; contentType: string; id: string }[];
      body: { content: string; contentType: string };
    };
    expect(payload.attachments).toHaveLength(1);
    const [attachment] = payload.attachments;
    expect(attachment?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(JSON.parse(attachment!.content)).toMatchObject({
      body: [
        {
          data: [
            { legend: "Passed", value: 9 },
            { legend: "Failed", value: 1 },
          ],
          title: "Checks",
          type: "Chart.Pie",
        },
      ],
      type: "AdaptiveCard",
      version: "1.5",
    });
    expect(payload.body).toEqual({
      content: `Results &lt;b&gt;&amp; notes&lt;/b&gt;<br>See chart<attachment id="${attachment!.id}"></attachment>`,
      contentType: "html",
    });
  });
});
