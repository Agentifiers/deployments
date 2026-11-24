import { describe, expect, test } from "bun:test";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";
import {
  classifyRecipients,
  composeContext,
  composeFields,
  forwardParts,
  readCompose,
  replyRecipients,
  requestBudget,
  sendConfirmation,
  type AgentEmailMessage,
} from "./compose-state.ts";

const INBOX = "support@agents.example.com";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const message = (overrides: Partial<AgentEmailMessage>): AgentEmailMessage => ({
  attachments: [],
  bccAddresses: [],
  ccAddresses: ["Cc@Example.com"],
  createdAt: "2026-10-07T11:00:00.000Z",
  direction: "inbound",
  fromAddress: "customer@example.com",
  id: Schema.decodeUnknownSync(PublicId)("01M4CKX44YV660DTZ4F0DG6618"),
  inboxId: Schema.decodeUnknownSync(PublicId)("01M4CKYVE38H6GPBEVRXT31REE"),
  organizationId: Schema.decodeUnknownSync(PublicId)("01ARZ3NDEKTSV4RRFFQ69G600C"),
  references: [],
  replyToAddresses: [],
  reprocessCount: 0,
  status: "received",
  subject: "Order",
  threadKey: "thread",
  toAddresses: [INBOX, "colleague@example.com"],
  updatedAt: "2026-10-07T11:00:00.000Z",
  ...overrides,
});

const context = {
  attachments: [],
  inboxAddress: INBOX,
  now: NOW,
  policyMaxAttachmentBytes: 4_194_304,
};
const blank = composeFields({ kind: "send" });

describe("reply recipients", () => {
  test("a reply goes to the sender, or its Reply-To when set", () => {
    expect(replyRecipients(message({}), INBOX, false)).toEqual(["customer@example.com"]);
    expect(
      replyRecipients(message({ replyToAddresses: ["desk@example.com"] }), INBOX, false),
    ).toEqual(["desk@example.com"]);
  });

  test("reply-all adds To and Cc but never this inbox", () => {
    expect(replyRecipients(message({}), INBOX, true)).toEqual([
      "customer@example.com",
      "colleague@example.com",
      "cc@example.com",
    ]);
  });

  test("a reply to this inbox's own outbound mail goes to its recipients", () => {
    expect(
      replyRecipients(
        message({ direction: "outbound", fromAddress: INBOX, toAddresses: ["a@example.com"] }),
        INBOX,
        false,
      ),
    ).toEqual(["a@example.com"]);
  });
});

describe("recipient classification", () => {
  const classes = classifyRecipients(
    ["Other@Agents.Example.com", "partner@example.com", "stranger@example.org"],
    new Set(["other@agents.example.com"]),
    [" Partner@example.com "],
  );

  test("sorts recipients into own inboxes, allowlisted, and external", () => {
    expect(Object.fromEntries(classes)).toEqual({
      "other@agents.example.com": "environment_inbox",
      "partner@example.com": "allowlisted",
      "stranger@example.org": "external",
    });
  });

  test("asks for the typed word when any recipient is outside the environment or in production", () => {
    expect(sendConfirmation(classes, "development")).toBe("send");
    const own = new Set(["other@agents.example.com"]);
    const allowlisted = classifyRecipients(
      ["other@agents.example.com", "partner@example.com"],
      own,
      ["partner@example.com"],
    );
    expect(sendConfirmation(allowlisted, "development")).toBe("send");
    const internal = classifyRecipients(["Other@agents.example.com"], own, []);
    expect(sendConfirmation(internal, "development")).toBe(undefined);
    expect(sendConfirmation(internal, "production")).toBe("send");
  });
});

describe("compose body", () => {
  test("a new message needs a recipient and carries only filled fields", () => {
    expect(readCompose({ kind: "send" }, blank, context)).toEqual({
      message: "Add at least one recipient.",
      ok: false,
    });
    expect(
      readCompose(
        { kind: "send" },
        { ...blank, subject: " Hi ", text: "Body", to: "B@agents.example.com" },
        context,
      ),
    ).toEqual({
      body: { subject: "Hi", text: "Body", to: ["b@agents.example.com"] },
      ok: true,
      recipients: ["b@agents.example.com"],
    });
  });

  test("a reply sends no To or subject and reports the derived recipients", () => {
    expect(
      readCompose(
        { all: false, kind: "reply", message: message({}) },
        { ...blank, text: "Thanks", to: "ignored@x.com" },
        context,
      ),
    ).toEqual({ body: { text: "Thanks" }, ok: true, recipients: ["customer@example.com"] });
  });

  test("a forward carries includeOriginal and a scheduled time as a UTC instant", () => {
    const result = readCompose(
      { kind: "forward", message: message({}) },
      {
        ...blank,
        includeOriginal: false,
        scheduledAt: "2026-10-08T09:30:00.000Z",
        to: "b@agents.example.com",
      },
      context,
    );
    expect(result).toEqual({
      body: {
        includeOriginal: false,
        scheduledAt: "2026-10-08T09:30:00.000Z",
        to: ["b@agents.example.com"],
      },
      ok: true,
      recipients: ["b@agents.example.com"],
    });
  });

  test("a send time in the past is refused", () => {
    expect(
      readCompose(
        { kind: "send" },
        { ...blank, scheduledAt: "2026-10-07T11:00:00.000Z", to: "b@x.com" },
        context,
      ),
    ).toEqual({ message: "The send time must be in the future.", ok: false });
  });

  test("a forward that quotes the original under a note counts the quote against the request budget", () => {
    const large = message({ textBody: "a".repeat(2_000_000) });
    const fields = { ...blank, text: "FYI", to: "b@agents.example.com" };
    const withAttachment = { ...context, attachments: [{ size: 1_000_000 }] };
    expect(readCompose({ kind: "forward", message: large }, fields, withAttachment)).toEqual({
      message:
        "The original message and the attachments are too large to forward with a note. Remove attachments, or clear the note so the platform quotes the original itself.",
      ok: false,
    });
    expect(
      readCompose({ kind: "forward", message: large }, { ...fields, text: "" }, withAttachment).ok,
    ).toBe(true);
    expect(
      readCompose(
        { kind: "forward", message: large },
        { ...fields, includeOriginal: false },
        withAttachment,
      ).ok,
    ).toBe(true);
  });

  test("a forward counts the quote as the JSON request carries it", () => {
    const newlines = message({ textBody: "\n".repeat(1_000_000) });
    expect(
      readCompose(
        { kind: "forward", message: newlines },
        { ...blank, text: "FYI", to: "b@agents.example.com" },
        { ...context, attachments: [{ size: 1_800_000 }] },
      ),
    ).toEqual({
      message:
        "The original message and the attachments are too large to forward with a note. Remove attachments, or clear the note so the platform quotes the original itself.",
      ok: false,
    });
  });

  test("a forward counts the quote as the Lambda event carries it, escaped a second time", () => {
    const backslashes = message({ textBody: "\\".repeat(500_000) });
    expect(
      readCompose(
        { kind: "forward", message: backslashes },
        { ...blank, text: "FYI", to: "b@agents.example.com" },
        { ...context, attachments: [{ size: 1_000_000 }] },
      ),
    ).toEqual({
      message:
        "The original message and the attachments are too large to forward with a note. Remove attachments, or clear the note so the platform quotes the original itself.",
      ok: false,
    });
  });

  test("a send, reply, or draft counts its typed text against the request budget", () => {
    const tooLong = {
      message:
        "The message is too large to send from the console. Shorten the text or remove attachments.",
      ok: false,
    } as const;
    const newlines = { ...blank, text: "\n".repeat(2_000_000), to: "b@agents.example.com" };
    expect(readCompose({ kind: "send" }, newlines, context)).toEqual(tooLong);
    expect(
      readCompose({ all: false, kind: "reply", message: message({}) }, newlines, context),
    ).toEqual(tooLong);
    expect(readCompose({ kind: "draft" }, newlines, context)).toEqual(tooLong);
    expect(
      readCompose(
        { kind: "send" },
        { ...newlines, text: "\n".repeat(200_000) },
        { ...context, attachments: [{ size: 3_000_000 }] },
      ),
    ).toEqual(tooLong);
    expect(
      readCompose(
        { kind: "send" },
        { ...newlines, text: "\n".repeat(200_000) },
        { ...context, attachments: [{ size: 2_500_000 }] },
      ).ok,
    ).toBe(true);
  });

  test("a draft may be saved without recipients", () => {
    expect(readCompose({ kind: "draft" }, { ...blank, subject: "Later" }, context)).toEqual({
      body: { subject: "Later", to: [] },
      ok: true,
      recipients: [],
    });
  });

  const savedDraft = {
    bccAddresses: ["audit@agents.example.com"],
    ccAddresses: ["b@agents.example.com"],
    createdAt: "2026-10-07T11:00:00.000Z",
    id: Schema.decodeUnknownSync(PublicId)("01M4D68EQWDE58EJM5Y3RSCVJQ"),
    inboxId: Schema.decodeUnknownSync(PublicId)("01M4CKX44YV660DTZ4F0DG6618"),
    metadata: {},
    organizationId: Schema.decodeUnknownSync(PublicId)("01ARZ3NDEKTSV4RRFFQ69G600C"),
    scheduledAt: "2026-10-08T09:30:00.000Z",
    status: "draft" as const,
    subject: "Later",
    textBody: "Draft body",
    toAddresses: ["a@agents.example.com"],
    updatedAt: "2026-10-07T11:00:00.000Z",
  };

  test("editing a saved draft resends its recipients and leaves an unchanged text and send time out", () => {
    const mode = { draft: savedDraft, kind: "draft" as const };
    expect(readCompose(mode, composeFields(mode), context)).toEqual({
      body: {
        bcc: ["audit@agents.example.com"],
        cc: ["b@agents.example.com"],
        subject: "Later",
        to: ["a@agents.example.com"],
      },
      ok: true,
      recipients: ["a@agents.example.com", "b@agents.example.com", "audit@agents.example.com"],
    });
  });

  test("editing an HTML-only draft adds no empty text part", () => {
    const { textBody: _textBody, ...htmlOnly } = savedDraft;
    const mode = { draft: { ...htmlOnly, htmlBody: "<p>Hi</p>" }, kind: "draft" as const };
    expect(readCompose(mode, { ...composeFields(mode), subject: "Sooner" }, context)).toEqual({
      body: {
        bcc: ["audit@agents.example.com"],
        cc: ["b@agents.example.com"],
        subject: "Sooner",
        to: ["a@agents.example.com"],
      },
      ok: true,
      recipients: ["a@agents.example.com", "b@agents.example.com", "audit@agents.example.com"],
    });
  });

  test("an unchanged send time keeps its seconds, even under a minute ahead", () => {
    const mode = {
      draft: { ...savedDraft, scheduledAt: "2026-10-07T12:00:30.000Z" },
      kind: "draft" as const,
    };
    const result = readCompose(mode, { ...composeFields(mode), text: "Edited" }, context);
    expect(result.ok && result.body).toEqual({
      bcc: ["audit@agents.example.com"],
      cc: ["b@agents.example.com"],
      subject: "Later",
      text: "Edited",
      to: ["a@agents.example.com"],
    });
  });

  test("editing a draft sends cleared recipients and text, since the API keeps omitted fields", () => {
    const { scheduledAt: _scheduledAt, ...unscheduled } = savedDraft;
    const mode = { draft: unscheduled, kind: "draft" as const };
    expect(
      readCompose(mode, { ...composeFields(mode), bcc: "", cc: "", text: "", to: "" }, context),
    ).toEqual({
      body: { bcc: [], cc: [], subject: "Later", text: "", to: [] },
      ok: true,
      recipients: [],
    });
  });

  test("editing a draft with a send time refuses to blank it or move it into the past", () => {
    const mode = { draft: savedDraft, kind: "draft" as const };
    expect(readCompose(mode, { ...composeFields(mode), scheduledAt: "" }, context)).toEqual({
      message: "A saved send time cannot be removed. Choose a new one in the future.",
      ok: false,
    });
    expect(
      readCompose(mode, { ...composeFields(mode), scheduledAt: "2026-10-07T11:00" }, context),
    ).toEqual({
      message: "The send time must be in the future.",
      ok: false,
    });
  });
});

describe("forward with a note", () => {
  test("puts the note above the quoted original in both parts and escapes it in HTML", () => {
    expect(
      forwardParts(
        "See <below>\nThanks",
        message({ htmlBody: "<p>Original</p>", subject: "Order", textBody: "Original" }),
      ),
    ).toEqual({
      html: "<div>See &lt;below&gt;<br>Thanks</div><br><div>---------- Forwarded message ----------<br><strong>From:</strong> customer@example.com<br><strong>To:</strong> support@agents.example.com, colleague@example.com<br><strong>Subject:</strong> Order<br><br><p>Original</p></div>",
      text: "See <below>\nThanks\n---------- Forwarded message ----------\nFrom: customer@example.com\nTo: support@agents.example.com, colleague@example.com\nSubject: Order\n\nOriginal",
    });
  });

  test("quotes a text-only original as escaped preformatted HTML", () => {
    expect(forwardParts("FYI", message({ textBody: "a < b" })).html).toBe(
      "<div>FYI</div><br><div>---------- Forwarded message ----------<br><strong>From:</strong> customer@example.com<br><strong>To:</strong> support@agents.example.com, colleague@example.com<br><strong>Subject:</strong> Order<br><br><pre>a &lt; b</pre></div>",
    );
  });
});

describe("request budget", () => {
  test("bounds count, the policy's raw bytes, the console's encoded bytes, and the whole event", () => {
    expect(requestBudget([{ size: 1_000 }], 4_194_304, 0)).toEqual({ ok: true });
    expect(
      requestBudget(
        Array.from({ length: 36 }, () => ({ size: 1 })),
        4_194_304,
        0,
      ),
    ).toEqual({
      ok: false,
      reason: "too_many",
    });
    expect(requestBudget([{ size: 2_000 }], 1_000, 0)).toEqual({
      ok: false,
      reason: "policy_limit",
    });
    expect(requestBudget([{ size: 3_500_000 }], 4_194_304, 0)).toEqual({
      ok: false,
      reason: "console_limit",
    });
    expect(requestBudget([], 4_194_304, 4_600_000)).toEqual({
      ok: false,
      reason: "request_limit",
    });
  });
});

describe("compose context", () => {
  test("is ready whenever a read succeeded, even after a failed background refetch", () => {
    const failure = new Error("offline");
    expect(composeContext({ data: undefined, error: null })).toEqual({ kind: "reading" });
    expect(composeContext({ data: undefined, error: failure })).toEqual({
      error: failure,
      kind: "failed",
    });
    expect(composeContext({ data: { complete: true }, error: failure })).toEqual({
      context: { complete: true },
      kind: "ready",
    });
  });
});
