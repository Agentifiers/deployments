import { describe, expect, test } from "bun:test";
import type { ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";

import { ChannelAttachmentDownloadError } from "./attachment-download.ts";
import {
  CHANNEL_ATTACHMENT_SOURCES,
  downloadChannelAttachment,
  type ChannelAttachmentReference,
  type ChannelAttachmentSources,
} from "./attachment-sources.ts";
import type { ChannelAttachment, ChannelProvider } from "./core.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SLACK_FILE_URL = "https://files.slack.com/files-pri/T0001-F0001/download/cat.png";
const TEAMS_CONTENT_URL =
  "https://smba.trafficmanager.net/amer/v3/attachments/0-cus-d1-abc/views/original";
const TELEGRAM_TOKEN = "123456:telegram-secret";
const TEAMS_VALUES = {
  appId: "00000000-0000-4000-8000-000000000001",
  appPassword: "secret-password",
  appTenantId: "11111111-2222-4333-8444-555555555555",
};

interface SentRequest {
  readonly authorization: string | undefined;
  readonly url: string;
}

function fakeProvider(respond: (url: URL) => Response) {
  const requests: SentRequest[] = [];
  return {
    options: {
      dnsLookup: () => [{ address: "93.184.216.34", family: 4 as const }],
      maxBytes: 1_024,
      pinnedRequest: async (request: ExecutePinnedHttpRequestOptions) => {
        const url = new URL(request.url);
        requests.push({ authorization: request.headers?.authorization, url: url.toString() });
        return respond(url);
      },
      signal: new AbortController().signal,
    },
    requests,
  };
}

function fakeTokenEndpoint() {
  const tokenRequests: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    tokenRequests.push(input instanceof Request ? input.url : String(input));
    return Response.json({
      access_token: `token-${String(tokenRequests.length)}`,
      expires_in: 3_599,
    });
  }) as typeof globalThis.fetch;
  return { fetch, tokenRequests };
}

async function rejection(download: Promise<Uint8Array>) {
  try {
    await download;
  } catch (error) {
    if (error instanceof ChannelAttachmentDownloadError) return error;
    throw error;
  }
  throw new Error("The download was expected to fail.");
}

describe("channel attachment sources", () => {
  test("the provider table maps RCS to undefined and covers every ChannelProvider", () => {
    const { aws_end_user_messaging_rcs, slack_cloudflare_edge, slack_edge, teams_bot_framework } =
      CHANNEL_ATTACHMENT_SOURCES;
    const slackImage: ChannelAttachment = {
      contentType: "image/png",
      kind: "image",
      providerAttachmentId: "F0001",
      url: SLACK_FILE_URL,
    };
    expect({
      aws_end_user_messaging_rcs,
      slack_cloudflare_edge: slack_cloudflare_edge?.(slackImage),
      slack_edge: slack_edge?.(slackImage),
      teams_bot_framework: teams_bot_framework?.({
        contentType: "image/png",
        kind: "image",
        url: TEAMS_CONTENT_URL,
      }),
      telegram: CHANNEL_ATTACHMENT_SOURCES.telegram?.({
        kind: "image",
        providerAttachmentId: "AgAD",
      }),
    }).toEqual({
      aws_end_user_messaging_rcs: undefined,
      slack_cloudflare_edge: { type: "slack-file", url: SLACK_FILE_URL },
      slack_edge: { type: "slack-file", url: SLACK_FILE_URL },
      teams_bot_framework: { contentUrl: TEAMS_CONTENT_URL, type: "teams-inline-image" },
      telegram: { fileId: "AgAD", type: "telegram-file" },
    });

    // @ts-expect-error
    const _withoutTelegram: ChannelAttachmentSources = {
      aws_end_user_messaging_rcs: undefined,
      slack_cloudflare_edge: undefined,
      slack_edge: undefined,
      teams_bot_framework: undefined,
    };
  });

  test("returns a reference only for an attachment with a provider-hosted handle", () => {
    const cases: readonly (readonly [ChannelProvider, ChannelAttachment])[] = [
      ["slack_edge", { kind: "image", url: SLACK_FILE_URL }],
      ["slack_edge", { kind: "image", url: "https://acme.slack.com/files/U0001/F0001/cat.png" }],
      [
        "slack_edge",
        { kind: "image", url: "http://files.slack.com/files-pri/T0001-F0001/cat.png" },
      ],
      [
        "teams_bot_framework",
        { contentType: "png", fileName: "cat.png", kind: "image", providerAttachmentId: "u-1" },
      ],
      ["telegram", { contentType: "image/jpeg", kind: "image" }],
    ];
    expect(
      cases.map(([provider, attachment]) => CHANNEL_ATTACHMENT_SOURCES[provider]?.(attachment)),
    ).toEqual([
      { type: "slack-file", url: SLACK_FILE_URL },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("Slack files and Telegram documents yield references; Teams files and RCS do not", () => {
    const workbookUrl = "https://files.slack.com/files-pri/T0001-F0003/download/budget.xlsx";
    const cases: readonly (readonly [ChannelProvider, ChannelAttachment])[] = [
      [
        "slack_edge",
        {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          fileName: "budget.xlsx",
          kind: "other",
          providerAttachmentId: "F0003",
          url: workbookUrl,
        },
      ],
      [
        "telegram",
        {
          contentType: "application/pdf",
          fileName: "report.pdf",
          kind: "document",
          providerAttachmentId: "BQACAgQAAx",
        },
      ],
      [
        "teams_bot_framework",
        {
          contentType: "application/pdf",
          fileName: "report.pdf",
          kind: "document",
          url: TEAMS_CONTENT_URL,
        },
      ],
      [
        "aws_end_user_messaging_rcs",
        {
          contentType: "image/png",
          kind: "image",
          providerAttachmentId: "rcs-1",
          url: SLACK_FILE_URL,
        },
      ],
      [
        "aws_end_user_messaging_rcs",
        { contentType: "application/pdf", kind: "document", providerAttachmentId: "rcs-2" },
      ],
    ];
    expect(
      cases.map(([provider, attachment]) => CHANNEL_ATTACHMENT_SOURCES[provider]?.(attachment)),
    ).toEqual([
      { type: "slack-file", url: workbookUrl },
      { fileId: "BQACAgQAAx", type: "telegram-file" },
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("downloadChannelAttachment", () => {
  test("Slack download follows a files.slack.com redirect with the bot token", async () => {
    const provider = fakeProvider((url) =>
      url.pathname.endsWith("/download/cat.png")
        ? new Response(null, {
            headers: { location: "/files-pri/T0001-F0001/cat.png" },
            status: 302,
          })
        : new Response(PNG),
    );
    expect(
      await downloadChannelAttachment(
        { type: "slack-file", url: SLACK_FILE_URL },
        { botToken: "xoxb-secret" },
        provider.options,
      ),
    ).toEqual(PNG);
    expect(provider.requests).toEqual([
      { authorization: "Bearer xoxb-secret", url: SLACK_FILE_URL },
      {
        authorization: "Bearer xoxb-secret",
        url: "https://files.slack.com/files-pri/T0001-F0001/cat.png",
      },
    ]);
  });

  test("Slack download refuses a cross-origin redirect and never sends the token off files.slack.com", async () => {
    const provider = fakeProvider((url) =>
      url.hostname === "files.slack.com"
        ? new Response(null, {
            headers: { location: "https://slack-files.evil.example/cat.png" },
            status: 302,
          })
        : new Response(PNG),
    );
    const error = await rejection(
      downloadChannelAttachment(
        { type: "slack-file", url: SLACK_FILE_URL },
        { accessToken: "xoxb-secret" },
        provider.options,
      ),
    );
    expect({ kind: error.kind, reason: error.reason }).toEqual({
      kind: "permanent",
      reason: "redirect_refused",
    });
    expect(provider.requests).toEqual([
      { authorization: "Bearer xoxb-secret", url: SLACK_FILE_URL },
    ]);
  });

  test("Teams download refuses a non-smba host", async () => {
    const offHost =
      "https://smba.trafficmanager.net.evil.example/amer/v3/attachments/a/views/original";
    expect(
      [TEAMS_CONTENT_URL, offHost].map((url) =>
        CHANNEL_ATTACHMENT_SOURCES.teams_bot_framework?.({
          contentType: "image/png",
          kind: "image",
          url,
        }),
      ),
    ).toEqual([{ contentUrl: TEAMS_CONTENT_URL, type: "teams-inline-image" }, undefined]);

    const provider = fakeProvider(() => new Response(PNG));
    const token = fakeTokenEndpoint();
    const error = await rejection(
      downloadChannelAttachment({ contentUrl: offHost, type: "teams-inline-image" }, TEAMS_VALUES, {
        ...provider.options,
        botTokenFetch: token.fetch,
      }),
    );
    expect({ kind: error.kind, reason: error.reason }).toEqual({
      kind: "permanent",
      reason: "host_not_allowed",
    });
    expect({ downloads: provider.requests, tokens: token.tokenRequests }).toEqual({
      downloads: [],
      tokens: [],
    });
  });

  test("Teams download sends the minted bot token to smba and re-authenticates after a 401", async () => {
    let attempts = 0;
    const provider = fakeProvider(() => {
      attempts += 1;
      return attempts === 1 ? new Response("", { status: 401 }) : new Response(PNG);
    });
    const token = fakeTokenEndpoint();
    const reference: ChannelAttachmentReference = {
      contentUrl: TEAMS_CONTENT_URL,
      type: "teams-inline-image",
    };
    const options = { ...provider.options, botTokenFetch: token.fetch };

    const error = await rejection(downloadChannelAttachment(reference, TEAMS_VALUES, options));
    expect({ kind: error.kind, reason: error.reason, status: error.status }).toEqual({
      kind: "permanent",
      reason: "rejected",
      status: 401,
    });
    expect(await downloadChannelAttachment(reference, TEAMS_VALUES, options)).toEqual(PNG);
    expect(provider.requests).toEqual([
      { authorization: "Bearer token-1", url: TEAMS_CONTENT_URL },
      { authorization: "Bearer token-2", url: TEAMS_CONTENT_URL },
    ]);
  });

  test("Teams download reports a token response without an access token as malformed", async () => {
    const provider = fakeProvider(() => new Response(PNG));
    const tokenWithoutAccessToken = Object.assign(
      async () => Response.json({ expires_in: 3_599, token_type: "Bearer" }),
      { preconnect: fetch.preconnect },
    );
    const error = await rejection(
      downloadChannelAttachment(
        { contentUrl: TEAMS_CONTENT_URL, type: "teams-inline-image" },
        TEAMS_VALUES,
        { ...provider.options, botTokenFetch: tokenWithoutAccessToken },
      ),
    );
    expect({ downloads: provider.requests, kind: error.kind, reason: error.reason }).toEqual({
      downloads: [],
      kind: "permanent",
      reason: "malformed_response",
    });
  });

  test("Telegram download resolves the file path with getFile and returns the file bytes", async () => {
    const provider = fakeProvider((url) =>
      url.pathname.endsWith("/getFile")
        ? Response.json({
            ok: true,
            result: { file_id: "AgAD", file_path: "photos/file_7.jpg", file_unique_id: "u1" },
          })
        : new Response(PNG),
    );
    expect(
      await downloadChannelAttachment(
        { fileId: "AgAD", type: "telegram-file" },
        { botToken: TELEGRAM_TOKEN },
        provider.options,
      ),
    ).toEqual(PNG);
    expect(provider.requests).toEqual([
      {
        authorization: undefined,
        url: `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=AgAD`,
      },
      {
        authorization: undefined,
        url: `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/photos/file_7.jpg`,
      },
    ]);
  });

  test("Telegram errors never contain the file URL", async () => {
    const provider = fakeProvider((url) => {
      if (url.pathname.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "photos/file_7.jpg" } });
      }
      throw new Error(`connect ECONNRESET ${url.toString()}`);
    });
    const error = await rejection(
      downloadChannelAttachment(
        { fileId: "AgAD", type: "telegram-file" },
        { botToken: TELEGRAM_TOKEN },
        provider.options,
      ),
    );
    expect({ kind: error.kind, reason: error.reason }).toEqual({
      kind: "transient",
      reason: "unreachable",
    });
    expect(provider.requests.at(-1)?.url).toBe(
      `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/photos/file_7.jpg`,
    );
    const rendered = Bun.inspect(error);
    expect(rendered).toContain("unreachable");
    expect(rendered).not.toContain(TELEGRAM_TOKEN);
    expect(rendered).not.toContain("/file/bot");
  });

  test("a response larger than the bound is cut", async () => {
    const bodies: { pulls: number }[] = [];
    const provider = fakeProvider(() => {
      const body = { pulls: 0 };
      bodies.push(body);
      const endless = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            body.pulls += 1;
            controller.enqueue(new Uint8Array(256));
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(
        endless,
        bodies.length === 1 ? { headers: { "content-length": "4096" } } : {},
      );
    });
    const reference: ChannelAttachmentReference = { type: "slack-file", url: SLACK_FILE_URL };
    const values = { accessToken: "xoxb-secret" };

    const declared = await rejection(
      downloadChannelAttachment(reference, values, provider.options),
    );
    const undeclared = await rejection(
      downloadChannelAttachment(reference, values, provider.options),
    );
    expect({
      pulls: bodies.map((body) => body.pulls),
      reasons: [declared.reason, undeclared.reason],
    }).toEqual({ pulls: [0, 5], reasons: ["too_large", "too_large"] });
  });
});
