import { describe, expect, test } from "bun:test";
import { decodePublicRequest, decodePublicResponse } from "./validation.ts";
import { normalizeEmailMailbox, normalizeEmailDomain } from "./email.ts";

const message = {
  from: '"Support, Inc." <support@example.com>',
  to: ["recipient@example.net"],
  subject: "Sign in",
  text: "Your requested link",
};

describe("tenant-scoped email contract", () => {
  test("accepts a single display-name mailbox but rejects lists and injected headers", () => {
    expect(decodePublicRequest("sendEmail", message)).toEqual(message);
    expect(normalizeEmailMailbox(message.from).domain).toBe("example.com");
    for (const from of [
      "one@example.com,two@example.com",
      "Group: one@example.com;",
      "support@example.com\r\nBcc: other@example.net",
      "Support <support@example.com> <other@example.net>",
    ]) {
      expect(() => decodePublicRequest("sendEmail", { ...message, from })).toThrow();
    }
    expect(() =>
      decodePublicRequest("sendEmail", { ...message, subject: "Sign in\nBcc: other" }),
    ).toThrow();
  });

  test("canonicalizes IDN and terminal-dot mailboxes without changing the local part", () => {
    expect(normalizeEmailMailbox("Case.Sensitive+tag@BÜCHER.example.")).toEqual({
      mailbox: "Case.Sensitive+tag@xn--bcher-kva.example",
      domain: "xn--bcher-kva.example",
    });
    expect(normalizeEmailMailbox('"Bücher, Inc." <Sender@BÜCHER.example.>')).toEqual({
      mailbox: "=?UTF-8?B?QsO8Y2hlciwgSW5jLg==?= <Sender@xn--bcher-kva.example>",
      domain: "xn--bcher-kva.example",
    });
    expect(() => normalizeEmailMailbox("Bücher@example.com")).toThrow();
  });

  test("quotes ASCII display-name specials and preserves escaped quoted names", () => {
    expect(normalizeEmailMailbox("Support (EU) [team] <help@example.com>").mailbox).toBe(
      '"Support (EU) [team]" <help@example.com>',
    );
    const mailbox = '"Support \\"team\\" \\\\ desk" <help@example.com>';
    expect(normalizeEmailMailbox(mailbox).mailbox).toBe(mailbox);
    expect(normalizeEmailMailbox('"Doe, Jane: <support>" <help@example.com>').mailbox).toBe(
      '"Doe, Jane: <support>" <help@example.com>',
    );
  });

  test("splits MIME words on UTF-8 character boundaries and preserves the display name", () => {
    const name = `${"a".repeat(44)}😀${"é😀".repeat(12)}`;
    const mailbox = normalizeEmailMailbox(`"${name}" <help@example.com>`).mailbox;
    const words = mailbox.slice(0, mailbox.indexOf(" <")).split(" ");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decoded = words
      .map((word) => {
        expect(word.length).toBeLessThanOrEqual(75);
        expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/u);
        return decoder.decode(Buffer.from(word.slice(10, -2), "base64"));
      })
      .join("");
    expect(decoded).toBe(name);
    expect(mailbox).toMatch(/^[\x20-\x7e]+$/u);
    // Encoded-looking user text stays literal, rather than introducing decoded controls.
    expect(normalizeEmailMailbox("=?UTF-8?B?DQpCY2M6?= <help@example.com>").mailbox).toBe(
      "=?UTF-8?B?PT9VVEYtOD9CP0RRcENZMk02Pz0=?= <help@example.com>",
    );
    expect(() => normalizeEmailMailbox('"broken\ud800" <help@example.com>')).toThrow();
  });

  test("checks canonical address and encoded header lengths after expansion", () => {
    const local = "a".repeat(64);
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
    expect(normalizeEmailMailbox(`${local}@${domain}`).mailbox.length).toBe(254);
    expect(() => normalizeEmailMailbox(`${local}@${domain}c`)).toThrow();
    const idnDomain = `${"é".repeat(57)}.${"é".repeat(57)}.${"é".repeat(57)}.example`;
    expect(() =>
      decodePublicRequest("sendEmail", { ...message, from: `${local}@${idnDomain}` }),
    ).toThrow();
    const name = "é".repeat(400);
    for (const field of ["from", "to", "cc", "bcc", "replyTo"]) {
      const mailbox = `"${name}" <help@example.com>`;
      expect(() =>
        decodePublicRequest("sendEmail", {
          ...message,
          [field]: field === "from" ? mailbox : [mailbox],
        }),
      ).toThrow();
      expect(() =>
        decodePublicRequest("sendEmail", {
          ...message,
          [field]:
            field === "from"
              ? "help@example.com\r\nBcc: other@example.net"
              : ["help@example.com\r\nBcc: other@example.net"],
        }),
      ).toThrow();
    }
  });

  test("counts all delivery recipients together, excluding reply-to", () => {
    const to = Array.from({ length: 49 }, (_, index) => `user${index}@example.net`);
    expect(
      decodePublicRequest("sendEmail", {
        ...message,
        to,
        cc: ["cc@example.net"],
        replyTo: ["reply@example.com"],
      }),
    ).toMatchObject({ to });
    expect(() =>
      decodePublicRequest("sendEmail", {
        ...message,
        to,
        cc: ["cc@example.net"],
        bcc: ["bcc@example.net"],
      }),
    ).toThrow();
    expect(() => decodePublicRequest("sendEmail", { ...message, to: [] })).toThrow();
  });

  test("bounds combined UTF-8 body bytes rather than characters or each body separately", () => {
    const text = "é".repeat(524_288);
    expect(decodePublicRequest("sendEmail", { ...message, text })).toMatchObject({ text });
    expect(() => decodePublicRequest("sendEmail", { ...message, text, html: "x" })).toThrow();
    expect(() => decodePublicRequest("sendEmail", { ...message, text: "", html: "" })).toThrow();
  });

  test("rejects native provider overrides and requires an explicit tenant update", () => {
    expect(() =>
      decodePublicRequest("sendEmail", { ...message, configurationSetName: "other" }),
    ).toThrow();
    expect(() => decodePublicRequest("sendEmail", { ...message, tenantName: "other" })).toThrow();
    expect(() => decodePublicRequest("updateEmailTenant", {})).toThrow();
    expect(decodePublicRequest("updateEmailTenant", { status: "paused" })).toEqual({
      status: "paused",
    });
  });

  test("canonicalizes DNS ownership names and rejects URL-shaped inputs", () => {
    expect(normalizeEmailDomain(" EXAMPLE.COM. ")).toBe("example.com");
    expect(normalizeEmailDomain("BÜCHER.example")).toBe("xn--bcher-kva.example");
    expect(normalizeEmailDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    for (const domain of [
      "example.com/path",
      "example.com:443",
      "a@b.example",
      "example.com?x",
      "-bad.example",
      "127.0.0.1",
    ]) {
      expect(() => decodePublicRequest("createEmailDomain", { domain })).toThrow();
    }
  });

  test("requires a provider acceptance receipt rather than a queued message", () => {
    const receipt = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "accepted",
      providerMessageId: "ses-message-id",
      acceptedAt: "2026-09-16T12:00:00.000Z",
    };
    expect(decodePublicResponse("sendEmail", receipt)).toEqual(receipt);
    expect(() => decodePublicResponse("sendEmail", { ...receipt, status: "queued" })).toThrow();
    const { providerMessageId: _providerMessageId, ...unaccepted } = receipt;
    expect(() => decodePublicResponse("sendEmail", unaccepted)).toThrow();
    expect(() => decodePublicResponse("sendEmail", { ...receipt, text: "secret" })).toThrow();
  });
});
