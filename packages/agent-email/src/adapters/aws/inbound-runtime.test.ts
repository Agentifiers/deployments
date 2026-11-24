import { describe, expect, it } from "bun:test";
import {
  boundedInboundMailboxes,
  boundedInboundReferences,
  agentEmailInboundThreadKey,
  normalizeSesReferences,
  normalizeSesThreadHeader,
  parseInboundAgentEmail,
} from "./runtime.ts";

describe("agent email inbound AWS runtime", () => {
  it("parses inbound MIME and derives a stable thread key", async () => {
    const raw = new TextEncoder().encode(
      [
        "From: Sender <sender@example.com>",
        "To: agent@agents.example.com",
        "Message-ID: <message-1@example.com>",
        "Subject: Hello",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello agent",
      ].join("\r\n"),
    );
    const parsed = await parseInboundAgentEmail(raw, "ses-1");
    expect(parsed.fromAddress).toBe("sender@example.com");
    expect(parsed.toAddresses).toEqual(["agent@agents.example.com"]);
    expect(parsed.threadKey).toBe("<message-1@example.com>");
  });

  it("bounds mailbox counts and bytes before persistence", async () => {
    const recipients = [
      `${"oversized".repeat(50)}@example.com`,
      ...Array.from(
        { length: 200 },
        (_, index) => `${"recipient".repeat(20)}-${index}@example.com`,
      ),
    ];
    const raw = new TextEncoder().encode(
      [
        "From: sender@example.com",
        `To: ${recipients.join(", ")}`,
        "Subject: Bounded recipients",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello agent",
      ].join("\r\n"),
    );

    const parsed = await parseInboundAgentEmail(raw, "ses-bounded");

    expect(parsed.toAddresses.length).toBeLessThanOrEqual(100);
    expect(parsed.toAddresses.every((address) => Buffer.byteLength(address, "utf8") <= 320)).toBe(
      true,
    );
    expect(Buffer.byteLength(parsed.toAddresses.join(","), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("bounds large address groups while iterating them", () => {
    const addresses = boundedInboundMailboxes({
      group: Array.from({ length: 150_000 }, (_, index) => ({
        address: `recipient-${index}@example.com`,
        name: "",
      })),
      name: "Large group",
    });

    expect(addresses).toHaveLength(100);
    expect(addresses[0]).toBe("recipient-0@example.com");
    expect(addresses.at(-1)).toBe("recipient-99@example.com");
  });

  it("hashes oversized inbound thread identifiers", () => {
    const value = agentEmailInboundThreadKey({ inReplyTo: "x".repeat(600) }, "ses-1");
    expect(value).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("uses the root References entry for reply-chain threading", () => {
    expect(
      agentEmailInboundThreadKey(
        {
          inReplyTo: "<parent@example.com>",
          references: "<root@example.com> <parent@example.com>",
        },
        "ses-1",
      ),
    ).toBe("<root@example.com>");
  });

  it("derives thread keys from large References headers without splitting them", () => {
    expect(
      agentEmailInboundThreadKey(
        {
          references: `<root@example.com> ${Array.from(
            { length: 100_000 },
            (_, index) => `<reply-${index}@example.com>`,
          ).join(" ")}`,
        },
        "ses-1",
      ),
    ).toBe("<root@example.com>");
  });

  it("bounds persisted inbound References while preserving the root and newest entries", () => {
    const values = [
      "<root@example.com>",
      ...Array.from({ length: 100 }, (_, index) => `<${"x".repeat(480)}-${index}@example.com>`),
    ];
    const references = boundedInboundReferences(values.join(" "));
    expect(references[0]).toBe("<root@example.com>");
    expect(references.at(-1)).toBe(values.at(-1));
    expect(references.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(references.join(" "), "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("skips oversized References tokens without materializing candidate arrays", () => {
    const newest = "<newest@example.com>";
    const references = boundedInboundReferences(
      `<root@example.com> ${"x".repeat(1024 * 1024)} ${newest}`,
    );

    expect(references).toEqual(["<root@example.com>", newest]);
  });

  it("rejects unsafe SES thread headers and bounds references", () => {
    expect(normalizeSesThreadHeader("hello\nworld")).toBeUndefined();
    expect(normalizeSesReferences(["<one>", "<two>"])).toBe("<one> <two>");
    const longReferences = [
      "<root@example.com>",
      ...Array.from({ length: 400 }, (_, index) => `<reply-${index}@example.com>`),
    ];
    const bounded = normalizeSesReferences(longReferences);
    expect(bounded?.startsWith("<root@example.com> ")).toBeTrue();
    expect(bounded?.endsWith("<reply-399@example.com>")).toBeTrue();
  });
});
