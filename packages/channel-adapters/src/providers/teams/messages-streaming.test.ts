import { describe, expect, test } from "bun:test";

import type { TeamsConnectorClient } from "./connector.ts";
import { teamsBotCredentials } from "./credentials.ts";
import {
  normalizeTeamsAgentIdentity,
  readTeamsDeliveryPayload,
  sendTeamsDelivery,
  teamsDeliveryPayload,
  teamsMarkdownMessageText,
} from "./messages.ts";
import {
  teamsAgentPlanText,
  teamsProgressText,
  teamsStreamFinalActivity,
  teamsStreamInformativeActivity,
  teamsTerminalText,
} from "./streaming.ts";

const NOTICE =
  "\n\n_Response truncated in Teams. Open Deployments.ai to view the complete result._";
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

describe("Teams messages", () => {
  test("validates agent identities", () => {
    expect(normalizeTeamsAgentIdentity(undefined)).toBeUndefined();
    expect(normalizeTeamsAgentIdentity({ displayName: "  Rex  " })).toEqual({ displayName: "Rex" });
    expect(() => normalizeTeamsAgentIdentity({ displayName: " " })).toThrow(TypeError);
    expect(() => normalizeTeamsAgentIdentity({ displayName: "x".repeat(81) })).toThrow(TypeError);
    expect(() => normalizeTeamsAgentIdentity({ displayName: "Rex\nAdmin" })).toThrow(TypeError);
    expect(() => normalizeTeamsAgentIdentity("Rex")).toThrow(TypeError);
  });

  test("prefixes an escaped bold identity label", () => {
    expect(teamsMarkdownMessageText("Done.", { displayName: "R*x_[bot]" })).toBe(
      "**R\\*x\\_\\[bot\\]**\n\nDone.",
    );
    expect(teamsMarkdownMessageText("Done.")).toBe("Done.");
  });

  test("bounds text to 24,000 UTF-8 bytes on a code point boundary", () => {
    const body = "€".repeat(9_000);
    const text = teamsMarkdownMessageText(body, { displayName: "Rex" });
    expect(byteLength(text)).toBeLessThanOrEqual(24_000);
    expect(text.startsWith("**Rex**\n\n€")).toBe(true);
    expect(text.endsWith(NOTICE)).toBe(true);
    expect(text.slice(0, -NOTICE.length)).toMatch(/^\*\*Rex\*\*\n\n(€)+$/u);
    expect(byteLength(text)).toBeGreaterThan(24_000 - 3);

    const emoji = teamsMarkdownMessageText("😀".repeat(7_000));
    expect(emoji.endsWith(NOTICE)).toBe(true);
    expect(emoji.slice(0, -NOTICE.length)).toMatch(/^(😀)+$/u);

    const exact = "a".repeat(24_000);
    expect(teamsMarkdownMessageText(exact)).toBe(exact);
  });

  test("builds, validates, and sends delivery payloads", async () => {
    const payload = teamsDeliveryPayload({
      body: "Report ready.",
      conversationId: " 19:general@thread.tacv2;messageid=1 ",
      identity: { displayName: "Rex" },
    });
    expect(payload).toEqual({
      conversationId: "19:general@thread.tacv2;messageid=1",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      text: "**Rex**\n\nReport ready.",
    });
    expect(readTeamsDeliveryPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(() =>
      readTeamsDeliveryPayload({ ...payload, serviceUrl: "https://evil.example/" }),
    ).toThrow(TypeError);
    expect(() => readTeamsDeliveryPayload({ ...payload, text: "x".repeat(24_001) })).toThrow(
      TypeError,
    );
    expect(() => teamsDeliveryPayload({ body: "  ", conversationId: "a:1" })).toThrow(TypeError);

    const sent: Parameters<TeamsConnectorClient["sendActivity"]>[0][] = [];
    const client: Pick<TeamsConnectorClient, "sendActivity"> = {
      sendActivity: async (input) => {
        sent.push(input);
        return { id: "activity-9" };
      },
    };
    const credentials = teamsBotCredentials({ appId: "app-1", appPassword: "pw" });
    expect(await sendTeamsDelivery({ client, credentials, payload })).toEqual({
      providerMessageId: "activity-9",
    });
    expect(sent).toEqual([
      {
        activity: { text: "**Rex**\n\nReport ready.", textFormat: "markdown", type: "message" },
        conversationId: "19:general@thread.tacv2;messageid=1",
        credentials,
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      },
    ]);
  });
});

describe("Teams streaming", () => {
  test("builds informative and final streaminfo activities", () => {
    expect(teamsStreamInformativeActivity({ sequence: 1, text: "Searching" })).toEqual({
      entities: [{ streamSequence: 1, streamType: "informative", type: "streaminfo" }],
      text: "Searching",
      type: "typing",
    });
    expect(
      teamsStreamInformativeActivity({
        sequence: 2,
        streamId: "stream-1",
        text: "x".repeat(1_500),
      }),
    ).toEqual({
      entities: [
        { streamId: "stream-1", streamSequence: 2, streamType: "informative", type: "streaminfo" },
      ],
      text: "x".repeat(1_000),
      type: "typing",
    });
    expect(() => teamsStreamInformativeActivity({ sequence: 2, text: "x" })).toThrow(TypeError);
    expect(() => teamsStreamInformativeActivity({ sequence: 0, text: "x" })).toThrow(RangeError);
    expect(teamsStreamFinalActivity({ streamId: "stream-1", text: "Answer" })).toEqual({
      entities: [{ streamId: "stream-1", streamType: "final", type: "streaminfo" }],
      text: "Answer",
      textFormat: "markdown",
      type: "message",
    });
  });

  test("summarizes plan and task updates as one status line", () => {
    expect(
      teamsAgentPlanText({
        eventType: "agent.plan.updated",
        plan: {
          tasks: [
            { id: "t1", status: "completed", title: "Read docs" },
            { id: "t2", status: "in_progress", title: "Draft reply" },
            { id: "t3", status: "pending", title: "Review" },
          ],
          title: "Answer the question",
        },
      }),
    ).toBe("Answer the question (1/3 done) — Working: Draft reply");
    expect(
      teamsAgentPlanText({
        eventType: "agent.task.updated",
        plan: { title: "Answer" },
        task: { details: "Found 3 sources", id: "t1", status: "failed", title: "Search" },
      }),
    ).toBe("Failed: Search — Found 3 sources");
    expect(
      teamsAgentPlanText({ eventType: "agent.task.updated", plan: { title: "Answer" } }),
    ).toBeUndefined();
  });

  test("summarizes tool progress and skips events Slack does not stream", () => {
    expect(
      teamsProgressText({
        eventType: "tool.call.started",
        level: "info",
        message: "Searching the web",
        metadata: { toolCallId: "call-1", toolName: "web.search" },
      }),
    ).toBe("Working: Use web.search — Searching the web");
    expect(
      teamsProgressText({ eventType: "sandbox.ready", level: "info", message: "Sandbox ready" }),
    ).toBe("Done: Sandbox ready");
    expect(
      teamsProgressText({
        eventType: "tool.call.completed",
        level: "error",
        message: "Timed out",
        metadata: { toolCallId: "call-1", toolName: "web.search" },
      }),
    ).toBe("Failed: Use web.search — Timed out");
    expect(
      teamsProgressText({
        eventType: "tool.policy-decided",
        level: "info",
        message: "Allowed",
        metadata: { toolCallId: "call-1" },
      }),
    ).toBeUndefined();
    expect(
      teamsProgressText({ eventType: "model.turn.started", level: "info", message: "Thinking" }),
    ).toBeUndefined();
  });

  test("renders terminal text with identity, truncation, and failure notices", () => {
    expect(
      teamsTerminalText({
        body: "All done.",
        identity: { displayName: "Rex" },
        status: "completed",
      }),
    ).toBe("**Rex**\n\nAll done.");
    expect(
      teamsTerminalText({ body: "x".repeat(30_000), status: "completed" }).endsWith(NOTICE),
    ).toBe(true);
    expect(teamsTerminalText({ body: "", status: "canceled" })).toBe(
      "_Request canceled._\n\nAgent run canceled.",
    );
    expect(
      teamsTerminalText({
        body: "partial",
        error: "Model quota exceeded",
        identity: { displayName: "Rex" },
        status: "failed",
      }),
    ).toBe("**Rex**\n\n_Request failed._\n\nModel quota exceeded");
  });
});
