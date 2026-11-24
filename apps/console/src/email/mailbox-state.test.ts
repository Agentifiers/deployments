import { describe, expect, test } from "bun:test";
import {
  canReprocess,
  mailBodyView,
  messageInFlight,
  opensInBrowser,
  parseDraftSearch,
  parseMessageSearch,
  parseThreadSearch,
  rawState,
  type MessageStatus,
} from "./mailbox-state.ts";

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("mailbox search", () => {
  test("keeps known filters and a trimmed query, and drops the rest", () => {
    expect(
      parseMessageSearch({ direction: "inbound", q: "  invoice ", status: "delivered" }),
    ).toEqual({
      direction: "inbound",
      q: "invoice",
      status: "delivered",
    });
    expect(parseMessageSearch({ direction: "sideways", q: "   ", status: "lost" })).toEqual({});
    expect(parseThreadSearch({ q: "order 42" })).toEqual({ q: "order 42" });
    expect(parseDraftSearch({ status: "pending_approval" })).toEqual({
      status: "pending_approval",
    });
    expect(parseDraftSearch({ status: "deleted" })).toEqual({});
  });

  test("caps the query at 200 characters", () => {
    expect(parseThreadSearch({ q: "a".repeat(300) }).q).toHaveLength(200);
  });
});

describe("message lifecycle", () => {
  test("polls only while outbound mail is queued, scheduled, or sending", () => {
    const statuses: readonly MessageStatus[] = [
      "queued",
      "scheduled",
      "sending",
      "delivered",
      "received",
      "failed",
    ];
    expect(statuses.map((status) => messageInFlight({ status }))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test("names whether the original is stored, as the runtime's raw and reprocess routes check", () => {
    expect(
      [
        { direction: "inbound" as const },
        { direction: "outbound" as const },
        { direction: "inbound" as const, rawPurgedAt: "2026-10-01T00:00:00.000Z" },
        { direction: "inbound" as const, rawRetentionExpiresAt: "2026-10-06T00:00:00.000Z" },
        { direction: "inbound" as const, rawRetentionExpiresAt: "2026-10-08T00:00:00.000Z" },
      ].map((message) => [rawState(message, NOW), canReprocess(message, NOW)]),
    ).toEqual([
      ["absent", false],
      ["absent", false],
      ["purged", false],
      ["expired", false],
      ["stored", true],
    ]);
    expect(
      canReprocess(
        { direction: "outbound", rawRetentionExpiresAt: "2026-10-08T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("message body view", () => {
  test("shows the text part, and an HTML-only part only as source", () => {
    expect(mailBodyView({ htmlBody: "<p>Hi</p>", textBody: "Hi" })).toEqual({
      html: "<p>Hi</p>",
      kind: "text",
      text: "Hi",
    });
    expect(mailBodyView({ textBody: "Hi" })).toEqual({ kind: "text", text: "Hi" });
    expect(mailBodyView({ htmlBody: "<p>Hi</p>", textBody: "" })).toEqual({
      html: "<p>Hi</p>",
      kind: "html_only",
    });
    expect(mailBodyView({ htmlBody: "", textBody: "" })).toEqual({ kind: "empty" });
  });
});

describe("attachment open", () => {
  test("opens only types a browser shows without running the sender's code", () => {
    const opens = [
      "text/plain",
      "TEXT/PLAIN; charset=utf-8",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
    ].filter(opensInBrowser);
    expect(opens).toHaveLength(7);
    expect(
      [
        "text/html",
        "image/svg+xml",
        "application/xhtml+xml",
        "text/xml",
        "application/octet-stream",
        "text/plain;charset=utf-8, text/html",
        "text/plain, text/html",
        "",
      ].filter(opensInBrowser),
    ).toEqual([]);
  });
});
