import { describe, expect, it } from "bun:test";

import {
  admitModel,
  admitModelReferences,
  agentModelGrantScope,
  type EffectiveModelPolicy,
} from "./model-policy.ts";
import {
  DEFAULT_OPERATOR_GRANT_PROVIDERS,
  MODEL_OPERATOR_GRANTS_ENV,
  type ModelOperatorGrant,
  operatorGrantAllowsModel,
  operatorGrantModelProvider,
  operatorGrantProviders,
  parseModelOperatorGrantsJson,
} from "./operator-grants.ts";

const NOVA = "bedrock/amazon.nova-micro-v1:0";
const HAIKU = "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const VENDOR = "openrouter/vendor/operator-granted";
const scope = agentModelGrantScope({
  agentDefinitionId: "agent_1",
  organizationId: "org_1",
  workspaceId: "workspace_1",
});
// A policy that admits nothing a test grants, and a catalog that knows nothing: every admission
// below comes from the grant or not at all.
const policy: EffectiveModelPolicy = {
  modelPolicyId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  rules: { includeCuratedModels: false, models: ["openai/o3"] },
  source: "model-policy",
};
const emptyCatalog = { has: () => false };

function admits(grants: readonly ModelOperatorGrant[], modelId: string, grantScope = scope) {
  const admission = admitModel(modelId, policy, emptyCatalog, { grants, scope: grantScope });
  expect(operatorGrantAllowsModel(grants, grantScope, modelId)).toBe(admission.allowed);
  if (admission.allowed) expect(admission.basis).toBe("operator-grant");
  return admission.allowed;
}

describe("operator grant parsing", () => {
  it("treats an empty value as no grants and canonicalizes entries", () => {
    expect(parseModelOperatorGrantsJson(undefined)).toEqual([]);
    expect(parseModelOperatorGrantsJson("  ")).toEqual([]);
    expect(
      parseModelOperatorGrantsJson(
        JSON.stringify([
          {
            agentId: "agent_1",
            allowedModels: [VENDOR, VENDOR],
            providers: ["openrouter", "openrouter"],
          },
          { organizationId: "org_1" },
        ]),
      ),
    ).toEqual([
      { agentId: "agent_1", allowedModels: [VENDOR], providers: ["openrouter"] },
      { organizationId: "org_1" },
    ]);
  });

  it("rejects malformed grants with config errors", () => {
    const rejects = (value: string, message: string) => {
      let error: unknown;
      try {
        parseModelOperatorGrantsJson(value);
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({
        _tag: "ModelGatewayConfigError",
        key: MODEL_OPERATOR_GRANTS_ENV,
        message: expect.stringContaining(message),
      });
    };
    rejects("{", "");
    rejects("{}", "Model grants JSON must be an array.");
    rejects("[null]", "Model grant 0 must be an object.");
    rejects(JSON.stringify([{ organizationId: "org_1", value: "vk" }]), "unsupported field value");
    rejects(JSON.stringify([{ providers: ["openai"] }]), "Model grant 0 must include a scope.");
    rejects(JSON.stringify([{ agentId: " " }]), "agentId must be a non-empty string");
    rejects(JSON.stringify([{ workspaceId: 7 }]), "workspaceId must be a non-empty string");
    rejects(
      JSON.stringify([{ organizationId: "org_1", providers: [] }]),
      "providers must be a non-empty list of strings",
    );
    rejects(
      JSON.stringify([{ organizationId: "org_1", allowedModels: ["gpt-5.2", 42] }]),
      "allowedModels must be a non-empty list of strings",
    );
    rejects(
      JSON.stringify([{ organizationId: "org_1", providers: ["anthropic"] }]),
      "lists unsupported provider anthropic",
    );
    rejects(
      JSON.stringify([{ organizationId: "*", workspaceId: "workspace_1" }]),
      'Model grant 0 with organizationId "*" applies to every organization and cannot include workspaceId or agentId.',
    );
    rejects(
      JSON.stringify([{ agentId: "agent_1", organizationId: "*" }]),
      'Model grant 0 with organizationId "*" applies to every organization and cannot include workspaceId or agentId.',
    );
  });

  it("defaults grant providers to OpenAI and OpenRouter", () => {
    expect(DEFAULT_OPERATOR_GRANT_PROVIDERS).toEqual(["openai", "openrouter"]);
    expect(operatorGrantProviders({ organizationId: "org_1" })).toEqual(["openai", "openrouter"]);
    expect(operatorGrantProviders({ organizationId: "org_1", providers: ["bedrock"] })).toEqual([
      "bedrock",
    ]);
    expect(operatorGrantModelProvider(NOVA)).toBe("bedrock");
    expect(operatorGrantModelProvider("OpenRouter/vendor/model")).toBe("openrouter");
    expect(operatorGrantModelProvider("openai/gpt-5.2")).toBe("openai");
  });
});

describe("operator grant admission (scoped-key equivalence)", () => {
  it("admits listed models for matching scopes only", () => {
    const grants = [{ allowedModels: [VENDOR], organizationId: "org_1" }];
    expect(admits(grants, VENDOR)).toBe(true);
    expect(admits(grants, VENDOR, { organizationId: "org_2" })).toBe(false);
    expect(admits([{ allowedModels: [VENDOR], agentId: "agent_2" }], VENDOR)).toBe(false);
    expect(
      admits([{ allowedModels: [VENDOR], organizationId: "org_1", workspaceId: "other" }], VENDOR),
    ).toBe(false);
    expect(admits([], VENDOR)).toBe(false);
  });

  it("lets the most specific scope decide: agent over workspace over organization", () => {
    const organization = { allowedModels: [VENDOR], organizationId: "org_1" };
    const workspace = {
      allowedModels: ["openrouter/vendor/workspace"],
      workspaceId: "workspace_1",
    };
    const agent = { agentId: "agent_1", allowedModels: ["openrouter/vendor/agent"] };

    expect(admits([organization, workspace], VENDOR)).toBe(false);
    expect(admits([organization, workspace], "openrouter/vendor/workspace")).toBe(true);
    expect(admits([organization, workspace, agent], "openrouter/vendor/workspace")).toBe(false);
    expect(admits([organization, workspace, agent], "openrouter/vendor/agent")).toBe(true);
    // Without the more specific grants, the organization grant applies again.
    expect(admits([organization], VENDOR)).toBe(true);
    // Grants for other agents do not shadow the organization grant.
    expect(
      admits([organization, { agentId: "agent_2", allowedModels: ["openai/gpt-4o"] }], VENDOR),
    ).toBe(true);
  });

  it("selects among equally specific grants by allowlist coverage", () => {
    const grants = [
      { allowedModels: ["openrouter/vendor/a"], organizationId: "org_1" },
      { allowedModels: ["openrouter/vendor/b"], organizationId: "org_1" },
    ];
    expect(admits(grants, "openrouter/vendor/a")).toBe(true);
    expect(admits(grants, "openrouter/vendor/b")).toBe(true);
    expect(admits(grants, "openrouter/vendor/c")).toBe(false);
  });

  it("lets the most specific scope serving the provider win even when it omits the model", () => {
    const grants = [
      { allowedModels: [VENDOR], organizationId: "org_1" },
      { agentId: "agent_1", allowedModels: ["openai/gpt-4o"] },
    ];
    // The agent grant serves openrouter by default, so it shadows the organization grant.
    expect(admits(grants, VENDOR)).toBe(false);
    // An agent grant that serves only openai does not compete for openrouter models.
    expect(
      admits(
        [
          grants[0]!,
          { agentId: "agent_1", allowedModels: ["openai/gpt-4o"], providers: ["openai"] },
        ],
        VENDOR,
      ),
    ).toBe(true);
    // A more specific curated-only grant also shadows broader explicit grants.
    expect(admits([grants[0]!, { agentId: "agent_1" }], VENDOR)).toBe(false);
  });

  it("serves OpenAI and OpenRouter by default and Bedrock only when listed", () => {
    expect(
      admits([{ allowedModels: ["openai/gpt-4o"], organizationId: "org_1" }], "openai/gpt-4o"),
    ).toBe(true);
    expect(admits([{ allowedModels: [NOVA], organizationId: "org_1" }], NOVA)).toBe(false);
    expect(
      admits([{ allowedModels: [NOVA], organizationId: "org_1", providers: ["openai"] }], NOVA),
    ).toBe(false);
    const bedrock = [
      { agentId: "agent_1", allowedModels: [NOVA], providers: ["bedrock" as const] },
    ];
    expect(admits(bedrock, NOVA)).toBe(true);
    expect(admits(bedrock, HAIKU)).toBe(false);
    expect(admits(bedrock, VENDOR)).toBe(false);
  });

  it("grants nothing beyond the curated models for `*` or omitted allowedModels", () => {
    expect(admits([{ organizationId: "org_1" }], "openai/gpt-5.2")).toBe(false);
    expect(admits([{ allowedModels: ["*"], organizationId: "org_1" }], "openai/gpt-5.2")).toBe(
      false,
    );
    expect(admits([{ allowedModels: ["*"], organizationId: "org_1" }], VENDOR)).toBe(false);
    expect(
      admits([{ allowedModels: ["*"], organizationId: "org_1", providers: ["bedrock"] }], NOVA),
    ).toBe(false);
    // `*` plus explicit models grants the explicit ones.
    expect(admits([{ allowedModels: ["*", VENDOR], organizationId: "org_1" }], VENDOR)).toBe(true);
  });

  it("matches provider-prefixed and provider-native ids case-insensitively", () => {
    const grants = [
      {
        allowedModels: ["gpt-4o", "Vendor/Native-Model", "amazon.nova-micro-v1:0"],
        organizationId: "org_1",
        providers: ["bedrock" as const, "openai" as const, "openrouter" as const],
      },
    ];
    expect(admits(grants, "openai/gpt-4o")).toBe(true);
    expect(admits(grants, "openrouter/vendor/native-model")).toBe(true);
    expect(admits(grants, NOVA)).toBe(true);
    expect(
      admits([{ allowedModels: ["OpenAI/GPT-4o"], organizationId: "org_1" }], "openai/gpt-4o"),
    ).toBe(true);
    // An entry matches as a canonical id or as a native id of the model's provider, so an
    // OpenRouter-native `openai/gpt-4o` covers `openrouter/openai/gpt-4o`, and Bedrock ids only
    // through a grant that serves Bedrock.
    const openAiNative = [{ allowedModels: ["openai/gpt-4o"], organizationId: "org_1" }];
    expect(admits(openAiNative, "openrouter/openai/gpt-4o")).toBe(true);
    expect(admits(openAiNative, "openrouter/gpt-4o")).toBe(false);
    expect(
      admits(
        [{ allowedModels: ["gpt-4o"], organizationId: "org_1", providers: ["bedrock"] }],
        "bedrock/gpt-4o",
      ),
    ).toBe(true);
    expect(admits([{ allowedModels: ["gpt-4o"], organizationId: "org_1" }], "bedrock/gpt-4o")).toBe(
      false,
    );
  });

  it("records the grant basis for every reference it admits", () => {
    const { admissions } = admitModelReferences(
      ["openai/o3", VENDOR, "openrouter/vendor/denied"],
      policy,
      new Map(),
      {
        grants: [{ agentId: "agent_1", allowedModels: [VENDOR, "openai/o3"] }],
        scope,
      },
    );
    expect(admissions).toEqual([
      expect.objectContaining({ allowed: true, basis: "operator-grant", modelId: "openai/o3" }),
      expect.objectContaining({ allowed: true, basis: "operator-grant", modelId: VENDOR }),
      expect.objectContaining({ allowed: false, modelId: "openrouter/vendor/denied" }),
    ]);
  });
});

describe("deployment-wide operator grants", () => {
  const LUNA = "openai/gpt-6-luna";
  const deploymentWide: ModelOperatorGrant = {
    allowedModels: [LUNA],
    organizationId: "*",
    providers: ["openai"],
  };

  it("parses organizationId * without a workspace or agent", () => {
    expect(
      parseModelOperatorGrantsJson(
        '[{"organizationId":"*","providers":["openai"],"allowedModels":["openai/gpt-6-luna"]}]',
      ),
    ).toEqual([{ allowedModels: [LUNA], organizationId: "*", providers: ["openai"] }]);
  });

  it("admits its models for any organization", () => {
    const grants = [deploymentWide];
    expect(admits(grants, LUNA)).toBe(true);
    expect(admits(grants, LUNA, { organizationId: "01J00000000000000000000ORG" })).toBe(true);
    expect(admits(grants, "openai/gpt-6-sol")).toBe(false);
  });

  it("does not apply to a scope without an organization", () => {
    const grants = [deploymentWide];
    expect(admits(grants, LUNA, {})).toBe(false);
    expect(admits(grants, LUNA, { agentId: "agent_1", workspaceId: "workspace_1" })).toBe(false);
    expect(admits(grants, LUNA, { organizationId: "  " })).toBe(false);
  });

  it("is shadowed by any organization grant serving the provider", () => {
    const organization = { allowedModels: ["openai/gpt-4o"], organizationId: "org_1" };
    expect(admits([deploymentWide, organization], LUNA)).toBe(false);
    expect(admits([organization, deploymentWide], LUNA, { organizationId: "org_2" })).toBe(true);
  });

  it("is not shadowed by a more specific grant serving another provider", () => {
    const openRouterAgent: ModelOperatorGrant = {
      agentId: "agent_1",
      allowedModels: [VENDOR],
      providers: ["openrouter"],
    };
    expect(admits([openRouterAgent, deploymentWide], LUNA)).toBe(true);
  });
});
