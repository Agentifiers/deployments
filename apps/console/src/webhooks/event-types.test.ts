import { WebhookEventTypes } from "@deployments-ai/api-contract/runtime";
import { describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { formatEventTypes, parseEventTypes } from "./event-types.ts";

describe("parseEventTypes", () => {
  test("splits on commas and newlines, trims, and drops blanks and duplicates", () => {
    expect(parseEventTypes(" run.completed,run.failed\n\nrun.completed , ", false)).toEqual({
      ok: true,
      value: ["run.completed", "run.failed"],
    });
  });

  test("collapses to every event when the switch is on or a wildcard is typed", () => {
    expect(parseEventTypes("run.completed", true)).toEqual({ ok: true, value: ["*"] });
    expect(parseEventTypes("run.completed, *", false)).toEqual({ ok: true, value: ["*"] });
    expect(parseEventTypes("", true)).toEqual({ ok: true, value: ["*"] });
  });

  test("requires at least one event type", () => {
    expect(parseEventTypes(" ,\n ", false)).toEqual({
      message: "Enter at least one event type, or subscribe to all events.",
      ok: false,
    });
  });

  test("accepts 100 event types and rejects 101", () => {
    const types = Array.from({ length: 101 }, (_, index) => `event.${index}`);
    expect(parseEventTypes(types.slice(0, 100).join(","), false)).toEqual({
      ok: true,
      value: types.slice(0, 100),
    });
    expect(parseEventTypes(types.join(","), false)).toEqual({
      message: "Enter at most 100 event types.",
      ok: false,
    });
  });

  test("accepts 128 characters per event type and rejects 129", () => {
    expect(parseEventTypes("a".repeat(128), false)).toEqual({ ok: true, value: ["a".repeat(128)] });
    expect(parseEventTypes(`run.failed, ${"b".repeat(129)}`, false)).toEqual({
      message: `Event types are at most 128 characters; "${"b".repeat(32)}…" is longer.`,
      ok: false,
    });
  });

  test("accepts exactly the counts and lengths the contract accepts", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => `event.${index}`);
    const lists = [hundred, [...hundred, "event.100"], ["a".repeat(128)], ["a".repeat(129)]];
    const contractAccepts = (eventTypes: readonly string[]) =>
      Option.isSome(Schema.decodeUnknownOption(WebhookEventTypes)(eventTypes));
    expect(
      lists.map((eventTypes) => [
        parseEventTypes(eventTypes.join(","), false).ok,
        contractAccepts(eventTypes),
      ]),
    ).toEqual([
      [true, true],
      [false, false],
      [true, true],
      [false, false],
    ]);
  });
});

describe("formatEventTypes", () => {
  test("names the wildcard and lists anything else", () => {
    expect(formatEventTypes(["*"])).toBe("All events");
    expect(formatEventTypes(["run.completed", "run.failed"])).toBe("run.completed, run.failed");
  });
});
