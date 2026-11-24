import { describe, expect, test } from "bun:test";
import { teamsBotFrameworkTokenVerifier } from "@deployments-ai/channel-adapters/teams";
import { ChannelBindingRecord, withCanonicalRecordKeys, type Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  handleChannelIngressWith,
  type ChannelIngressQueueMessageV1,
  type HttpApiEventLike,
} from "./ingress.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const APP_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";
const CHANNEL_CONVERSATION = "19:abc@thread.tacv2";

const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
  withCanonicalRecordKeys({
    data: {
      agentDefinitionId: id("5"),
      agentDeploymentId: id("6"),
      channel: "teams",
      createdAt: "2026-07-25T12:00:00.000Z",
      credentialRef: { credentialId: id("7"), generation: 1, store: "dynamodb-kms" },
      environmentId: id("2"),
      externalChannelId: CHANNEL_CONVERSATION,
      externalWorkspaceId: "tenant-1",
      id: id("1"),
      organizationId: id("3"),
      projectId: id("4"),
      provider: "teams_bot_framework",
      status: "active",
      updatedAt: "2026-07-25T12:00:00.000Z",
      version: 0,
    },
    itemType: "channel-binding" as const,
  }),
);

function signingKey(kid: string, endorsements: readonly string[]) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    jwk: { ...publicKey.export({ format: "jwk" }), endorsements, kid, use: "sig" },
    token(claims: Readonly<Record<string, unknown>> = {}) {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const input = `${segment({ alg: "RS256", kid, typ: "JWT" })}.${segment({
        aud: APP_ID,
        exp: nowSeconds + 3_600,
        iss: "https://api.botframework.com",
        nbf: nowSeconds - 60,
        serviceUrl: SERVICE_URL,
        ...claims,
      })}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    },
  };
}

/** Bot Framework OpenID endpoints; a fresh function per test keeps verifier key caches isolated. */
function botFrameworkFetch(keys: readonly object[], status = 200) {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (status !== 200) return new Response("unavailable", { status });
    if (url.endsWith("/openidconfiguration")) return Response.json({ jwks_uri: JWKS_URL });
    if (url === JWKS_URL) return Response.json({ keys });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function activity(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    channelData: {
      channel: { id: CHANNEL_CONVERSATION },
      team: { aadGroupId: "group-1", id: "19:team@thread.tacv2" },
      tenant: { id: "tenant-1" },
    },
    channelId: "msteams",
    conversation: {
      conversationType: "channel",
      id: `${CHANNEL_CONVERSATION};messageid=1699999999999`,
      tenantId: "tenant-1",
    },
    entities: [
      { mentioned: { id: `28:${APP_ID}`, name: "Bot" }, text: "<at>Bot</at>", type: "mention" },
      {
        mentioned: { id: "tag-1", name: "Reviewers", type: "tag" },
        text: "<at>Reviewers</at>",
        type: "mention",
      },
    ],
    from: { aadObjectId: "aad-user-1", id: "29:user-1", name: "Ada" },
    id: "1700000000001",
    recipient: { id: `28:${APP_ID}`, name: "Bot" },
    serviceUrl: SERVICE_URL,
    text: "<at>Bot</at> please review &amp; ship <at>Reviewers</at>",
    timestamp: "2026-07-25T12:00:00.000Z",
    type: "message",
    ...overrides,
  };
}

async function ingest(input: {
  readonly authorization: string;
  readonly body: unknown;
  readonly fetch: typeof fetch;
}) {
  const enqueued: ChannelIngressQueueMessageV1[] = [];
  const event: HttpApiEventLike = {
    body: JSON.stringify(input.body),
    headers: { authorization: input.authorization, "content-type": "application/json" },
    pathParameters: {
      bindingId: binding.data.id,
      environmentId: binding.data.environmentId,
      organizationId: binding.data.organizationId,
      provider: "teams_bot_framework",
    },
  };
  const result = await handleChannelIngressWith(event, {
    enqueue: async (message) => {
      enqueued.push(message);
    },
    loadBinding: async () => binding,
    readCredentialValues: async () => ({ appId: APP_ID, appPassword: "app-password" }),
    teamsTokenVerifier: teamsBotFrameworkTokenVerifier({ fetch: input.fetch }),
  });
  return { body: JSON.parse(result.body) as unknown, enqueued, statusCode: result.statusCode };
}

describe("Teams Bot Framework channel ingress", () => {
  test("accepts an authenticated channel message and enqueues sanitized Teams ingress", async () => {
    const key = signingKey("key-1", ["msteams"]);
    const result = await ingest({
      authorization: `Bearer ${key.token()}`,
      body: activity({ channelData: { ...activity().channelData, unexpected: "x" } }),
      fetch: botFrameworkFetch([key.jwk]),
    });

    expect(result).toMatchObject({ body: { accepted: true }, statusCode: 202 });
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]).toMatchObject({
      bindingId: binding.data.id,
      environmentId: binding.data.environmentId,
      organizationId: binding.data.organizationId,
      projectId: binding.data.projectId,
      type: "channel.ingress",
    });
    expect(result.enqueued[0]?.ingress).toEqual({
      channel: "teams",
      content: "please review & ship @Reviewers",
      externalAccountId: APP_ID,
      externalChannelId: CHANNEL_CONVERSATION,
      externalMessageId: `teams:tenant-1:${CHANNEL_CONVERSATION}:1700000000001`,
      externalThreadKey: `teams:tenant-1:thread:${CHANNEL_CONVERSATION};messageid=1699999999999`,
      externalWorkspaceId: "tenant-1",
      metadata: {
        teamsActivityId: "1700000000001",
        teamsChannelId: CHANNEL_CONVERSATION,
        teamsConversationType: "channel",
        teamsFromId: "29:user-1",
        teamsMentionIds: ["tag-1"],
        teamsServiceUrl: SERVICE_URL,
        teamsTeamAadGroupId: "group-1",
        teamsTeamId: "19:team@thread.tacv2",
      },
      occurredAt: "2026-07-25T12:00:00.000Z",
      provider: "teams_bot_framework",
      sender: { displayName: "Ada", id: "aad-user-1" },
    });
  });

  test("rejects a token issued for another bot without enqueuing", async () => {
    const key = signingKey("key-1", ["msteams"]);
    const result = await ingest({
      authorization: `Bearer ${key.token({ aud: "another-bot" })}`,
      body: activity(),
      fetch: botFrameworkFetch([key.jwk]),
    });

    expect(result).toEqual({ body: { error: "invalid_signature" }, enqueued: [], statusCode: 401 });
  });

  test("forbids a signing key that is not endorsed for Teams", async () => {
    const key = signingKey("key-1", ["skype"]);
    const result = await ingest({
      authorization: `Bearer ${key.token()}`,
      body: activity(),
      fetch: botFrameworkFetch([key.jwk]),
    });

    expect(result).toEqual({ body: { error: "forbidden" }, enqueued: [], statusCode: 403 });
  });

  test("acknowledges authenticated non-message activities without enqueuing", async () => {
    const key = signingKey("key-1", ["msteams"]);
    const result = await ingest({
      authorization: `Bearer ${key.token()}`,
      body: activity({ type: "conversationUpdate" }),
      fetch: botFrameworkFetch([key.jwk]),
    });

    expect(result).toEqual({
      body: { ignored: "unsupported_activity_type" },
      enqueued: [],
      statusCode: 202,
    });
  });

  test("answers 5xx when Bot Framework signing metadata is unavailable so Teams redelivers", async () => {
    const key = signingKey("key-1", ["msteams"]);
    const result = await ingest({
      authorization: `Bearer ${key.token()}`,
      body: activity(),
      fetch: botFrameworkFetch([key.jwk], 503),
    });

    expect(result).toEqual({
      body: { error: "verification_unavailable" },
      enqueued: [],
      statusCode: 503,
    });
  });

  test("rejects a malformed activity body as an invalid request", async () => {
    const key = signingKey("key-1", ["msteams"]);
    const result = await ingest({
      authorization: `Bearer ${key.token()}`,
      body: { type: "message" },
      fetch: botFrameworkFetch([key.jwk]),
    });

    expect(result).toEqual({ body: { error: "invalid_request" }, enqueued: [], statusCode: 400 });
  });
});
