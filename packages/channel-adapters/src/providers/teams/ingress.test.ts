import { describe, expect, test } from "bun:test";

import { externalThreadTarget } from "../../shared/core.ts";
import {
  TeamsIngressError,
  type TeamsBotFrameworkTokenVerifier,
  teamsBotFrameworkTokenVerifier,
} from "./bot-framework-auth.ts";
import {
  fakeBotFrameworkKeyServer,
  TEST_APP_ID,
  TEST_SERVICE_URL,
  testSigningKey,
} from "./bot-framework-auth.fixture.ts";
import { teamsActivityActionFromRequest, teamsMentionIds } from "./ingress.ts";

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const BOT_ID = `28:${TEST_APP_ID}`;
const acceptingVerifier: TeamsBotFrameworkTokenVerifier = { verify: async () => {} };

function activity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    channelData: { tenant: { id: TENANT_ID } },
    channelId: "msteams",
    conversation: { conversationType: "personal", id: "a:1personal", tenantId: TENANT_ID },
    from: { aadObjectId: "aad-user-1", id: "29:user-1", name: "Ada Lovelace" },
    id: "1700000000001",
    recipient: { id: BOT_ID, name: "Helper" },
    serviceUrl: TEST_SERVICE_URL,
    text: "hello there",
    timestamp: "2026-09-30T12:00:00.000Z",
    type: "message",
    ...overrides,
  };
}

function channelActivity(
  conversationId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return activity({
    channelData: {
      channel: { id: "19:general@thread.tacv2" },
      team: { aadGroupId: "team-aad-1", id: "19:team@thread.tacv2" },
      tenant: { id: TENANT_ID },
    },
    conversation: { conversationType: "channel", id: conversationId, tenantId: TENANT_ID },
    ...overrides,
  });
}

function act(body: unknown, verifier = acceptingVerifier) {
  return teamsActivityActionFromRequest({
    appId: TEST_APP_ID,
    authorization: "Bearer token",
    rawBody: JSON.stringify(body),
    verifier,
  });
}

async function messageRequest(body: unknown) {
  const action = await act(body);
  if (action.type !== "message") throw new Error(`Expected message, got ${action.reason}`);
  return action.request;
}

describe("Teams activity ingress", () => {
  test("normalizes a personal chat message", async () => {
    const request = await messageRequest(activity());
    expect(request).toEqual({
      channel: "teams",
      content: "hello there",
      externalAccountId: TEST_APP_ID,
      externalChannelId: "a:1personal",
      externalMessageId: `teams:${TENANT_ID}:a:1personal:1700000000001`,
      externalThreadKey: `teams:${TENANT_ID}:thread:a:1personal`,
      externalWorkspaceId: TENANT_ID,
      idempotencyKey: `teams:${TENANT_ID}:a:1personal:1700000000001`,
      metadata: {
        teamsActivityId: "1700000000001",
        teamsConversationType: "personal",
        teamsFromId: "29:user-1",
        teamsServiceUrl: TEST_SERVICE_URL,
      },
      occurredAt: "2026-09-30T12:00:00.000Z",
      provider: "teams_bot_framework",
      sender: { displayName: "Ada Lovelace", id: "aad-user-1" },
    });
    expect(externalThreadTarget(request.externalThreadKey)).toBe("a:1personal");
  });

  test("normalizes a group chat with the tenant from the conversation", async () => {
    const request = await messageRequest(
      activity({
        channelData: {},
        conversation: {
          conversationType: "groupChat",
          id: "19:group@thread.v2",
          isGroup: true,
          tenantId: TENANT_ID,
        },
      }),
    );
    expect(request.externalChannelId).toBe("19:group@thread.v2");
    expect(request.externalThreadKey).toBe(`teams:${TENANT_ID}:thread:19:group@thread.v2`);
    expect(request.metadata).toMatchObject({ teamsConversationType: "groupChat" });
  });

  test("threads a channel root post under its own activity id", async () => {
    const request = await messageRequest(channelActivity("19:general@thread.tacv2"));
    expect(request.externalChannelId).toBe("19:general@thread.tacv2");
    expect(externalThreadTarget(request.externalThreadKey)).toBe(
      "19:general@thread.tacv2;messageid=1700000000001",
    );
    expect(request.metadata).toMatchObject({
      teamsChannelId: "19:general@thread.tacv2",
      teamsConversationType: "channel",
      teamsTeamAadGroupId: "team-aad-1",
      teamsTeamId: "19:team@thread.tacv2",
    });
  });

  test("keeps a channel reply in its existing thread with a base channel id", async () => {
    const request = await messageRequest(
      channelActivity("19:general@thread.tacv2;messageid=1699999999999", {
        id: "1700000000555",
        replyToId: "1699999999999",
      }),
    );
    expect(request.externalChannelId).toBe("19:general@thread.tacv2");
    expect(request.externalThreadKey).toBe(
      `teams:${TENANT_ID}:thread:19:general@thread.tacv2;messageid=1699999999999`,
    );
    expect(request.externalMessageId).toBe(
      `teams:${TENANT_ID}:19:general@thread.tacv2:1700000000555`,
    );
    expect(request.metadata).toMatchObject({ teamsReplyToId: "1699999999999" });
  });

  test("drops the bot mention, renders other mentions, and cleans HTML", async () => {
    const body = channelActivity("19:general@thread.tacv2", {
      entities: [
        { mentioned: { id: BOT_ID, name: "Helper" }, text: "<at>Helper</at>", type: "mention" },
        {
          mentioned: { id: "tag-research", name: "Research", type: "tag" },
          text: "<at>Research</at>",
          type: "mention",
        },
        { mentioned: { id: "29:user-2", name: "Grace" }, text: "<at>Grace</at>", type: "mention" },
        {
          mentioned: { id: "tag-research", name: "Research" },
          text: "<at>Research</at>",
          type: "mention",
        },
        { type: "clientInfo", locale: "en-US" },
      ],
      text: "<p><at>Helper</at> ask <at>Research</at> &amp; <at>Grace</at>&nbsp;about &lt;b&gt;   R&amp;D</p><p>second&#39;s&nbsp;line</p>",
    });
    const request = await messageRequest(body);
    expect(request.content).toBe("ask @Research & @Grace about <b> R&D\nsecond's line");
    expect(request.metadata).toMatchObject({ teamsMentionIds: ["tag-research", "29:user-2"] });
    expect(teamsMentionIds(body, TEST_APP_ID)).toEqual(["tag-research", "29:user-2"]);
    expect(
      teamsMentionIds(
        { entities: [{ mentioned: { id: TEST_APP_ID }, type: "mention" }] },
        TEST_APP_ID,
      ),
    ).toEqual([]);
  });

  test("summarizes files without keeping pre-authenticated download URLs", async () => {
    const request = await messageRequest(
      activity({
        attachments: [
          {
            content: {
              downloadUrl: "https://contoso.sharepoint.com/download?tempauth=secret",
              fileType: "pdf",
              uniqueId: "file-unique-1",
            },
            contentType: "application/vnd.microsoft.teams.file.download.info",
            name: "plan.pdf",
          },
          {
            contentType: "image/png",
            contentUrl: "https://smba.trafficmanager.net/amer/v3/attachments/img-1/views/original",
            name: "chart.png",
          },
          { content: "<p>hello there</p>", contentType: "text/html" },
        ],
      }),
    );
    expect(request.content).toBe(
      "hello there\nFile shared: plan.pdf (pdf)\nFile shared: chart.png (image/png)",
    );
    expect(request.attachments).toEqual([
      {
        contentType: "pdf",
        fileName: "plan.pdf",
        kind: "document",
        providerAttachmentId: "file-unique-1",
      },
      {
        contentType: "image/png",
        fileName: "chart.png",
        kind: "image",
        url: "https://smba.trafficmanager.net/amer/v3/attachments/img-1/views/original",
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("tempauth");
  });

  test("ignores non-message activities, bot authors, empty text, and foreign service URLs", async () => {
    expect(await act(activity({ type: "conversationUpdate" }))).toEqual({
      reason: "unsupported_activity_type",
      type: "ignored",
    });
    expect(await act(activity({ type: "invoke" }))).toMatchObject({ type: "ignored" });
    expect(await act(activity({ from: { id: "28:other-bot", name: "Other" } }))).toEqual({
      reason: "bot_message",
      type: "ignored",
    });
    expect(
      await act(
        activity({
          text: "<at>Helper</at>",
          entities: [{ mentioned: { id: BOT_ID }, text: "<at>Helper</at>", type: "mention" }],
        }),
      ),
    ).toEqual({ reason: "empty_message", type: "ignored" });
    expect(await act(activity({ serviceUrl: "https://attacker.example/teams/" }))).toEqual({
      reason: "disallowed_service_url",
      type: "ignored",
    });
    expect(await act(activity({ serviceUrl: "http://smba.trafficmanager.net/teams/" }))).toEqual({
      reason: "disallowed_service_url",
      type: "ignored",
    });
    expect(await act(activity({ channelId: "webchat" }))).toEqual({
      reason: "unsupported_channel",
      type: "ignored",
    });
  });

  test("rejects malformed bodies with 400 and unauthenticated activities before normalization", async () => {
    const malformed = await teamsActivityActionFromRequest({
      appId: TEST_APP_ID,
      authorization: "Bearer token",
      rawBody: "{not json",
      verifier: acceptingVerifier,
    }).catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(TeamsIngressError);
    expect((malformed as TeamsIngressError).status).toBe(400);

    const key = await testSigningKey("kid-ingress");
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([key.jwk]).fetch,
    });
    const forged = await teamsActivityActionFromRequest({
      appId: TEST_APP_ID,
      authorization: `Bearer ${await key.sign({ audience: "someone-else" })}`,
      rawBody: JSON.stringify(activity({ type: "conversationUpdate" })),
      verifier,
    }).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(TeamsIngressError);
    expect((forged as TeamsIngressError).status).toBe(401);

    const accepted = await teamsActivityActionFromRequest({
      appId: TEST_APP_ID,
      authorization: `Bearer ${await key.sign()}`,
      rawBody: JSON.stringify(activity()),
      verifier,
    });
    expect(accepted.type).toBe("message");
  });
});
