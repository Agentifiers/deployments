import { describe, expect, it } from "bun:test";
import { estimateRuntimeContextTokens, packRuntimeModelContext } from "./model-gateway.ts";
import { id, request } from "./model-tool-context.fixture.ts";

describe("model gateway runtime adapter", () => {
  it("uses a UTF-8 byte upper bound for context admission", () => {
    expect(estimateRuntimeContextTokens("abcd")).toBe(4);
    expect(estimateRuntimeContextTokens("😀")).toBe(4);
  });

  it("grounds the current turn in elapsed conversation time", () => {
    const packed = packRuntimeModelContext(
      request({
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [
          {
            content: "The synthetic activity can start now.",
            createdAt: "2026-08-10T15:58:00.000Z",
            role: "user",
          },
          {
            content: "The synthetic activity is underway.",
            createdAt: "2026-08-10T16:00:00.000Z",
            role: "assistant",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(packed.messages[0]).toEqual({
      content: expect.stringContaining("1 day, 2 hours, 30 minutes"),
      role: "system",
    });
    expect(
      packed.messages.some(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("CONVERSATION TIMING (trusted runtime instructions)"),
      ),
    ).toBe(false);
    expect(JSON.stringify(packed.messages)).toContain("resumed conversation");
    expect(JSON.stringify(packed.messages)).toContain(
      "latest live exchange contained 2 messages over 2 minutes; the assistant spoke last",
    );
    expect(JSON.stringify(packed.messages)).not.toContain("2026-08-11T18:30:00.000Z");
  });

  it("binds stale historical content to the time when that message was sent", () => {
    const packed = packRuntimeModelContext(
      request({
        prompt: "How was the meal?",
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [
          {
            content: "The noodles just arrived.",
            createdAt: "2026-08-10T18:30:00.000Z",
            role: "assistant",
          },
          {
            content: "I finished a routine task.",
            createdAt: "2026-08-11T18:28:00.000Z",
            role: "user",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    const staleMessage = packed.messages.find(
      (message) =>
        message.role === "assistant" && String(message.content).includes("noodles just arrived"),
    );
    expect(String(staleMessage?.content)).toContain(
      "Platform timing: sent 1 day before the current turn",
    );
    expect(packed.messages[0]).toEqual({
      content: expect.stringContaining("CONVERSATION TIMING (trusted runtime instructions)"),
      role: "system",
    });
    expect(packed.messages).toContainEqual({
      content: "I finished a routine task.",
      role: "user",
    });
  });

  it("strips a previously leaked platform timing label before rebinding stale history", () => {
    const leakedLabel =
      "[Platform timing: sent 1 hour, 42 minutes before the current turn. Treat momentary state in this message as belonging to that earlier time; do not repeat this label.]";
    const packed = packRuntimeModelContext(
      request({
        prompt: "How was the meal?",
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [
          {
            content: `${leakedLabel}\nThe noodles just arrived.`,
            createdAt: "2026-08-10T18:30:00.000Z",
            role: "assistant",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    const staleMessage = packed.messages.find(
      (message) =>
        message.role === "assistant" && String(message.content).includes("noodles just arrived"),
    );
    expect(String(staleMessage?.content)).toBe(
      [
        "[Platform timing: sent 1 day before the current turn. Treat momentary state in this message as belonging to that earlier time; do not repeat this label.]",
        "The noodles just arrived.",
      ].join("\n"),
    );
    expect(String(staleMessage?.content)).not.toContain("1 hour, 42 minutes");
  });

  it("removes a leaked platform timing label from recent history", () => {
    const leakedLabel =
      "[Platform timing: sent 1 hour, 42 minutes before the current turn. Treat momentary state in this message as belonging to that earlier time; do not repeat this label.]";
    const packed = packRuntimeModelContext(
      request({
        prompt: "still there?",
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [
          {
            content: `${leakedLabel}\nmissed u. what are u up to?`,
            createdAt: "2026-08-11T18:28:00.000Z",
            role: "assistant",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(packed.messages).toContainEqual({
      content: "missed u. what are u up to?",
      role: "assistant",
    });
    expect(JSON.stringify(packed.messages)).not.toContain("Platform timing:");
  });

  it("grounds checkpoint summaries and recalled episodes in their source time", () => {
    const packed = packRuntimeModelContext(
      request({
        conversationCheckpoint: {
          fromMessageCreatedAt: "2026-08-09T17:00:00.000Z",
          fromSequence: 0,
          sourceMessageCount: 12,
          summary: "A delivery arrived during the earlier conversation.",
          throughMessageCreatedAt: "2026-08-10T18:30:00.000Z",
          throughSequence: 11,
        },
        memories: [
          {
            content: "The noodles arrived during the prior evening's conversation.",
            createdAt: "2026-08-10T18:35:00.000Z",
            memoryId: id("90"),
            memoryType: "episode",
            sensitivity: "internal",
            validFrom: "2026-08-10T18:30:00.000Z",
          },
        ],
        prompt: "How was the meal?",
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    const context = JSON.stringify(packed.messages);
    expect(context).toContain("source messages span from 2 days, 1 hour, 30 minutes earlier");
    expect(context).toContain("through 1 day earlier");
    expect(context).toContain(
      "episode; valid from 1 day earlier; recorded 23 hours, 55 minutes earlier",
    );
  });

  it("grounds the first turn of a continued thread in its trusted predecessor timing", () => {
    const packed = packRuntimeModelContext(
      request({
        conversationTimingAnchor: {
          createdAt: "2026-08-10T16:00:00.000Z",
          role: "assistant",
        },
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(packed.messages[0]).toEqual({
      content: expect.stringContaining("1 day, 2 hours, 30 minutes"),
      role: "system",
    });
    expect(JSON.stringify(packed.messages)).toContain("resumed conversation");
    expect(JSON.stringify(packed.messages)).toContain("assistant spoke last");
  });

  it("prefers exact current-thread timing over an older continuation anchor", () => {
    const packed = packRuntimeModelContext(
      request({
        conversationTimingAnchor: {
          createdAt: "2026-08-01T16:00:00.000Z",
          role: "assistant",
        },
        promptCreatedAt: "2026-08-11T18:30:00.000Z",
        recentMessages: [
          {
            content: "A synthetic current-thread message.",
            createdAt: "2026-08-11T17:30:00.000Z",
            role: "user",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(JSON.stringify(packed.messages)).toContain("1 hour earlier");
    expect(JSON.stringify(packed.messages)).not.toContain("10 days");
  });

  it("does not spend model context on ordinary live-turn timing", () => {
    const packed = packRuntimeModelContext(
      request({
        promptCreatedAt: "2026-08-10T16:05:00.000Z",
        recentMessages: [
          {
            content: "A synthetic live-chat response.",
            createdAt: "2026-08-10T16:00:00.000Z",
            role: "assistant",
          },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(JSON.stringify(packed.messages)).not.toContain(
      "CONVERSATION TIMING (trusted runtime instructions)",
    );
  });
});
