import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AgentResponseFormat,
  MAX_RESPONSE_SCHEMA_BYTES,
  validateStructuredResponse,
} from "./response-format.ts";

const format = {
  type: "json_schema" as const,
  name: "action_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["actions"],
    properties: {
      actions: {
        type: "array",
        maxItems: 8,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "text"],
              properties: { kind: { const: "text" }, text: { type: "string", minLength: 1 } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "asset"],
              properties: { kind: { const: "media" }, asset: { type: "string", minLength: 1 } },
            },
          ],
        },
      },
    },
  },
};

describe("bounded final JSON contracts", () => {
  test("validates nested discriminated actions rather than merely parsing JSON", () => {
    const decoded = Schema.decodeUnknownSync(AgentResponseFormat)(format);
    const valid = '{"actions":[{"kind":"text","text":"hello"},{"kind":"media","asset":"asset-1"}]}';
    validateStructuredResponse(valid, decoded);
    expect(() =>
      validateStructuredResponse('{"actions":[{"kind":"media","text":"wrong field"}]}', decoded),
    ).toThrow();
    expect(() => validateStructuredResponse("```json\n" + valid + "\n```", decoded)).toThrow();
    expect(() => validateStructuredResponse('{"actions":[],"extra":true}', decoded)).toThrow();
  });

  test("rejects remote and recursive refs, regex execution and unbounded uniqueness", () => {
    const decode = Schema.decodeUnknownSync(AgentResponseFormat);
    for (const schema of [
      { $ref: "https://example.com/schema" },
      { $ref: "#" },
      { type: "string", pattern: "^(a+)+$" },
      { type: "array", uniqueItems: true },
      { type: "object", description: "x".repeat(MAX_RESPONSE_SCHEMA_BYTES) },
    ])
      expect(() => decode({ ...format, schema })).toThrow();
    const unique = decode({
      ...format,
      schema: { type: "array", uniqueItems: true, maxItems: 16, items: { type: "string" } },
    });
    expect(() => validateStructuredResponse('["same","same"]', unique)).toThrow();
  });

  test("accepts a full bounded union and rejects recursive object input without overflowing", () => {
    const schema = {
      oneOf: Array.from({ length: 26 }, (_, index) => ({
        type: "object",
        required: ["kind"],
        properties: { kind: { const: `action-${index}` } },
        additionalProperties: false,
      })),
    };
    const decoded = Schema.decodeUnknownSync(AgentResponseFormat)({ ...format, schema });
    validateStructuredResponse('{"kind":"action-25"}', decoded);
    const cyclic: Record<string, unknown> = {};
    cyclic.properties = { again: cyclic };
    expect(() =>
      Schema.decodeUnknownSync(AgentResponseFormat)({ ...format, schema: cyclic }),
    ).toThrow();
  });
});
