import { describe, expect, test } from "bun:test";
import { ModelPolicyResponse } from "@deployments-ai/api-contract/models";
import { Schema } from "effect";
import { draftFrom, draftRules, policyTransition } from "./model-policy-state.ts";

const active = Schema.decodeUnknownSync(ModelPolicyResponse)({
  createdAt: "2026-10-01T00:00:00.000Z",
  description: "Production models",
  id: "01M4MPC00000000000000000PA",
  includeCuratedModels: true,
  models: ["openai/gpt-5.4-mini", "openrouter/*"],
  name: "Prod",
  status: "active",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 3,
});

describe("draftRules", () => {
  test("reads one trimmed entry per line and skips blank lines", () => {
    expect(
      draftRules({
        description: "",
        entries: "  openai/gpt-5.4-mini \r\n\n openrouter/*\n",
        includeCuratedModels: false,
        name: "x",
      }),
    ).toEqual({ includeCuratedModels: false, models: ["openai/gpt-5.4-mini", "openrouter/*"] });
  });
});

describe("policyTransition", () => {
  test("creates from curated defaults without an empty description", () => {
    expect(
      policyTransition(undefined, {
        description: "  ",
        entries: "openai/gpt-5.4-mini",
        includeCuratedModels: true,
        name: " QA ",
      }),
    ).toEqual({
      body: { includeCuratedModels: true, models: ["openai/gpt-5.4-mini"], name: "QA" },
      kind: "create",
    });
  });

  test("an unchanged draft patches nothing", () => {
    expect(policyTransition(active, draftFrom(active))).toEqual({
      expectedVersion: 3,
      kind: "update",
      patch: {},
      policyId: "01M4MPC00000000000000000PA",
    });
  });

  test("patches only the changed fields and clears a description with an empty string", () => {
    expect(
      policyTransition(active, {
        description: "",
        entries: "openai/gpt-5.4-mini",
        includeCuratedModels: false,
        name: "Prod",
      }),
    ).toEqual({
      expectedVersion: 3,
      kind: "update",
      patch: { description: "", includeCuratedModels: false, models: ["openai/gpt-5.4-mini"] },
      policyId: "01M4MPC00000000000000000PA",
    });
  });

  test("reordering entries is a change", () => {
    expect(
      policyTransition(active, {
        ...draftFrom(active),
        entries: "openrouter/*\nopenai/gpt-5.4-mini",
      }),
    ).toEqual({
      expectedVersion: 3,
      kind: "update",
      patch: { models: ["openrouter/*", "openai/gpt-5.4-mini"] },
      policyId: "01M4MPC00000000000000000PA",
    });
  });
});
