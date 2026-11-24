import { describe, expect, test } from "bun:test";
import { readSendDraft } from "./tenant-state.ts";

describe("readSendDraft", () => {
  const draft = {
    bcc: "",
    cc: "",
    domain: "send.example.com",
    localPart: "notices",
    subject: "Hello",
    text: "Body",
    to: "a@example.com",
  };

  test("builds the body with a From on the chosen domain", () => {
    expect(readSendDraft(draft)).toEqual({
      body: {
        from: "notices@send.example.com",
        subject: "Hello",
        text: "Body",
        to: ["a@example.com"],
      },
      ok: true,
    });
  });

  test("counts To, Cc, and Bcc together against 50 recipients", () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${index}@example.com`).join(",");
    expect(readSendDraft({ ...draft, cc: many("c", 25), to: many("t", 26) })).toEqual({
      message: "A message can have at most 50 recipients.",
      ok: false,
    });
  });

  test("needs a To address and a body", () => {
    expect(readSendDraft({ ...draft, to: "" })).toEqual({
      message: "Add at least one To address.",
      ok: false,
    });
    expect(readSendDraft({ ...draft, text: " " })).toEqual({
      message: "Write a message body.",
      ok: false,
    });
  });
});
