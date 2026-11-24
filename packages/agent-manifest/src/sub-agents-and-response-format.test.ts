import { describe, expect, it } from "bun:test";
import {
  MAX_AGENT_SUB_AGENTS,
  agentManifestContentHash,
  validateAgentDeploymentConfig,
  validateAgentManifest,
  type AgentManifestValidationResult,
} from "./index.ts";

const DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// Content hash of `baseManifest()` before optional sub-agents and release response formats
// existed. Omitting both fields must keep every previously published release identity stable.
const BASE_MANIFEST_HASH =
  "sha256:97babb240fd8f5a5fff11756cc1fd51bb3c32eb76395c16e113eb43bf89920b0";

function baseManifest() {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          {
            authorization: "workspace",
            name: "records.read",
            required: true,
            requiredScopes: ["records:read"],
          },
        ],
      },
      instructions: "Answer using the available records.",
      memory: { mode: "workspace" },
      model: { fallbackIds: ["openrouter/fallback"], id: "openrouter/default" },
      runtime: {
        contextCheckpointMode: "auto",
        modelInputTokenBudget: 32_000,
        modelOutputTokenReserve: 2_000,
        recentMessageCharacterBudget: 64_000,
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "records-read",
            input: { limit: 10 },
            inputSummary: "Read the latest records.",
            requiredScopes: ["records:read"],
            toolName: "records.read",
          },
        ],
      },
      sandbox: { mode: "none" },
      skills: ["Use source evidence."],
      triggers: ["api", "schedule"],
    },
  };
}

const responseFormat = {
  name: "answer",
  schema: {
    additionalProperties: false,
    properties: { answer: { type: "string" } },
    required: ["answer"],
    type: "object",
  },
  type: "json_schema",
};

function withRuntime(runtime: Record<string, unknown>) {
  const manifest = baseManifest();
  return {
    ...manifest,
    spec: { ...manifest.spec, runtime: { ...manifest.spec.runtime, ...runtime } },
  };
}

function orchestrator(
  agents: readonly Record<string, unknown>[],
  runtime?: Record<string, unknown>,
) {
  const manifest = baseManifest();
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      agents,
      capabilities: {
        tools: [
          ...manifest.spec.capabilities.tools,
          { name: "agent.delegate", required: true, requiredScopes: [] },
        ],
      },
      runtime: { ...manifest.spec.runtime, modelTools: ["agent.delegate"], ...runtime },
    },
  };
}

const researcher = {
  agentKey: "research.agent",
  awaitResult: true,
  description: "Researches a question and answers with sources.",
  key: "researcher",
  required: true,
};

function issueCodes(result: AgentManifestValidationResult) {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("release-pinned structured output", () => {
  it("keeps existing release hashes when the new optional fields are omitted", () => {
    expect(agentManifestContentHash(baseManifest())).toBe(BASE_MANIFEST_HASH);
    const validated = validateAgentManifest(baseManifest());
    expect(validated).toMatchObject({ contentHash: BASE_MANIFEST_HASH, ok: true });
  });

  it("pins a validated response format into a new release identity", () => {
    const result = validateAgentManifest(withRuntime({ responseFormat }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.contentHash).not.toBe(BASE_MANIFEST_HASH);
    expect(JSON.parse(result.canonicalJson).spec.runtime.responseFormat).toEqual(responseFormat);
    expect(agentManifestContentHash(JSON.parse(result.canonicalJson))).toBe(result.contentHash);
  });

  it("rejects unbounded or referenced response schemas at publish", () => {
    const invalid = validateAgentManifest(
      withRuntime({
        responseFormat: { ...responseFormat, schema: { $ref: "https://example.invalid/schema" } },
      }),
    );
    expect(invalid).toMatchObject({ ok: false });
  });

  it("refuses to pin a response format together with a response depth policy", () => {
    const result = validateAgentManifest(
      withRuntime({
        responseDepthPolicy: {
          classifierInstructions: "Choose depth.",
          detailedInstructions: "Go deep.",
          maximumWords: 200,
          minimumWords: 100,
        },
        responseFormat,
      }),
    );
    expect(issueCodes(result)).toEqual(["structured_response_conflicts_with_depth"]);
  });
});

describe("declared sub-agents", () => {
  it("accepts declared sub-agents reachable through agent.delegate", () => {
    const result = validateAgentManifest(orchestrator([researcher]));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.contentHash).not.toBe(BASE_MANIFEST_HASH);
  });

  it("rejects duplicate keys, self targets, and missing delegate wiring", () => {
    expect(
      issueCodes(
        validateAgentManifest(orchestrator([researcher, { ...researcher, required: false }])),
      ),
    ).toEqual(["duplicate_sub_agent_key"]);
    expect(
      issueCodes(
        validateAgentManifest(orchestrator([{ ...researcher, agentKey: "example.assistant" }])),
      ),
    ).toEqual(["sub_agent_targets_self"]);
    const manifest = baseManifest();
    expect(
      issueCodes(
        validateAgentManifest({ ...manifest, spec: { ...manifest.spec, agents: [researcher] } }),
      ),
    ).toEqual(["sub_agents_require_delegate_capability"]);
    expect(
      issueCodes(validateAgentManifest(orchestrator([researcher], { modelTools: [] }))),
    ).toEqual(["sub_agents_require_delegate_tool"]);
  });

  it("bounds the declared sub-agent list and each entry", () => {
    const agents = Array.from({ length: MAX_AGENT_SUB_AGENTS + 1 }, (_, index) => ({
      ...researcher,
      key: `researcher-${index}`,
    }));
    expect(validateAgentManifest(orchestrator(agents))).toMatchObject({ ok: false });
    expect(
      validateAgentManifest(orchestrator([{ ...researcher, edgeKind: "scheduled_child" }])),
    ).toMatchObject({ ok: false });
    expect(
      validateAgentManifest(orchestrator([{ ...researcher, description: "x".repeat(4_097) }])),
    ).toMatchObject({ ok: false });
  });
});

describe("sub-agent deployment bindings", () => {
  const config = (agentBindings?: Record<string, unknown>) => ({
    apiVersion: "agents.deployments.ai/v1",
    kind: "AgentDeploymentConfig",
    ...(agentBindings ? { agentBindings } : {}),
    toolAuthorizations: { "records.read": { authorizationId: DEPLOYMENT_ID } },
  });
  const optionalReviewer = {
    agentKey: "review.agent",
    description: "Reviews drafts.",
    key: "reviewer",
    required: false,
  };
  const manifest = orchestrator([researcher, optionalReviewer]);

  it("requires every required key and accepts leaving optional keys unbound", () => {
    expect(
      validateAgentDeploymentConfig(
        config({ researcher: { agentDeploymentId: DEPLOYMENT_ID } }),
        manifest,
      ),
    ).toMatchObject({ ok: true });
    const missing = validateAgentDeploymentConfig(config(), manifest);
    expect(missing.ok ? [] : missing.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["missing_agent_binding", "/agentBindings/researcher"],
    ]);
  });

  it("rejects undeclared keys and non-ULID deployment identifiers", () => {
    const undeclared = validateAgentDeploymentConfig(
      config({
        researcher: { agentDeploymentId: DEPLOYMENT_ID },
        writer: { agentDeploymentId: DEPLOYMENT_ID },
      }),
      manifest,
    );
    expect(undeclared.ok ? [] : undeclared.issues.map((issue) => issue.code)).toEqual([
      "undeclared_agent_binding",
    ]);
    expect(
      validateAgentDeploymentConfig(
        config({ researcher: { agentDeploymentId: "researcher" } }),
        manifest,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateAgentDeploymentConfig(
        config({ researcher: { agentDeploymentId: DEPLOYMENT_ID } }),
        baseManifest(),
      ),
    ).toMatchObject({ ok: false });
  });
});
