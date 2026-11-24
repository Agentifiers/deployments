import { describe, expect, it } from "bun:test";
import {
  decideModelFunding,
  fundingForProvider,
  type ModelFundingCandidate,
  type ModelFundingClaim,
  type OperatorModelSpend,
} from "./model-funding.ts";

describe("fundingForProvider", () => {
  const claim = { openai: { credentialId: "cred_openai", keyVersion: 4 } };

  it("names the organization credential for a provider the claim funds", () => {
    expect(fundingForProvider(claim, "openai")).toEqual({
      credentialId: "cred_openai",
      keyVersion: 4,
      kind: "organization",
      provider: "openai",
    });
  });

  it("leaves unclaimed providers, Bedrock, and claimless tokens to the operator", () => {
    expect(fundingForProvider(claim, "openrouter")).toEqual({ kind: "operator" });
    expect(fundingForProvider(claim, "bedrock")).toEqual({ kind: "operator" });
    expect(fundingForProvider(undefined, "openai")).toEqual({ kind: "operator" });
  });
});

const OPENAI_KEY: ModelFundingClaim = {
  openai: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G0010", keyVersion: 3 },
};
const GPT: ModelFundingCandidate = {
  embedding: false,
  modelId: "openai/gpt-5.2",
  provider: "openai",
};
const GLM: ModelFundingCandidate = {
  embedding: false,
  modelId: "openrouter/z-ai/glm-5.2",
  provider: "openrouter",
};
const EMBEDDING: ModelFundingCandidate = {
  embedding: true,
  modelId: "openai/text-embedding-3-small",
  provider: "openai",
};
const HAIKU: ModelFundingCandidate = {
  embedding: false,
  modelId: "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  provider: "bedrock",
};

function decide(
  credentials: ModelFundingClaim,
  models: readonly ModelFundingCandidate[],
  spend: OperatorModelSpend,
) {
  let reads = 0;
  return decideModelFunding({
    credentials,
    models,
    operatorSpend: async () => {
      reads += 1;
      return spend;
    },
  }).then((decision) => ({ decision, reads }));
}

const exhausted = {
  ceilingUsdMicros: 5_000_000,
  kind: "metered",
  spentUsdMicros: 5_000_000,
} as const;

describe("model funding decision", () => {
  it("an organization key pays for its provider's models without reading operator spend", async () => {
    expect(await decide(OPENAI_KEY, [GPT], exhausted)).toEqual({
      decision: {
        claim: { openai: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G0010", keyVersion: 3 } },
        kind: "funded",
        modelIds: ["openai/gpt-5.2"],
      },
      reads: 0,
    });
  });

  it("the operator pays under an unlimited ceiling", async () => {
    expect(await decide({}, [GPT, GLM], { kind: "unlimited" })).toEqual({
      decision: {
        claim: {},
        kind: "funded",
        modelIds: ["openai/gpt-5.2", "openrouter/z-ai/glm-5.2"],
      },
      reads: 1,
    });
  });

  it("the operator pays while month-to-date operator spend is below the ceiling", async () => {
    expect(
      await decide({}, [GLM], {
        ceilingUsdMicros: 5_000_000,
        kind: "metered",
        spentUsdMicros: 4_999_999,
      }),
    ).toEqual({
      decision: { claim: {}, kind: "funded", modelIds: ["openrouter/z-ai/glm-5.2"] },
      reads: 1,
    });
  });

  it("drops operator-funded fallbacks of an organization-funded primary once spend reaches the ceiling", async () => {
    expect(await decide(OPENAI_KEY, [GPT, GLM, HAIKU], exhausted)).toEqual({
      decision: {
        claim: { openai: { credentialId: "01ARZ3NDEKTSV4RRFFQ69G0010", keyVersion: 3 } },
        kind: "funded",
        modelIds: ["openai/gpt-5.2"],
      },
      reads: 1,
    });
  });

  it("refuses an operator-funded primary once spend reaches the ceiling, naming the ceiling", async () => {
    expect(await decide(OPENAI_KEY, [GLM, GPT], exhausted)).toEqual({
      decision: {
        kind: "refused",
        modelId: "openrouter/z-ai/glm-5.2",
        spend: { ceilingUsdMicros: 5_000_000, kind: "metered", spentUsdMicros: 5_000_000 },
      },
      reads: 1,
    });
  });

  it("a zero ceiling refuses every operator-funded model", async () => {
    expect(
      await decide({}, [GLM], { ceilingUsdMicros: 0, kind: "metered", spentUsdMicros: 0 }),
    ).toEqual({
      decision: {
        kind: "refused",
        modelId: "openrouter/z-ai/glm-5.2",
        spend: { ceilingUsdMicros: 0, kind: "metered", spentUsdMicros: 0 },
      },
      reads: 1,
    });
  });

  it("embeddings stay operator-funded under an organization key and are never refused", async () => {
    expect(await decide(OPENAI_KEY, [EMBEDDING], exhausted)).toEqual({
      decision: { claim: {}, kind: "funded", modelIds: ["openai/text-embedding-3-small"] },
      reads: 0,
    });
  });

  it("a Bedrock model is operator-funded even when the claim names other providers", async () => {
    expect(await decide(OPENAI_KEY, [HAIKU], { kind: "unlimited" })).toEqual({
      decision: {
        claim: {},
        kind: "funded",
        modelIds: ["bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"],
      },
      reads: 1,
    });
  });
});
