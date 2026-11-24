import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  AgentResponseDepthPolicy,
  MAX_AGENT_SANDBOX_MEMORY_MIB,
  MAX_AGENT_SANDBOX_VCPU,
  MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS,
  MAX_MODEL_OUTPUT_TOKEN_RESERVE,
  agentManifestContentHash,
  validateAgentManifest,
} from "./index.ts";
import { manifest } from "./manifest.fixture.ts";

describe("agent manifest", () => {
  it("matches runtime model, tool, sandbox, and semantic-version constraints", () => {
    expect(
      validateAgentManifest({
        ...manifest(),
        metadata: { ...manifest().metadata, version: "1.0.0-rc.1+build.7" },
      }),
    ).toMatchObject({ ok: true });
    for (const version of ["1.0.0-01", "1.0.0-.."] as const) {
      expect(
        validateAgentManifest({
          ...manifest(),
          metadata: { ...manifest().metadata, version },
        }),
      ).toMatchObject({ ok: false });
    }

    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          model: {
            fallbackIds: ["fallback/1", "fallback/2", "fallback/3", "fallback/4"],
            id: "openrouter/default",
          },
        },
      }),
    ).toMatchObject({ ok: false });

    for (const idempotencyKey of [
      "x".repeat(MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS + 1),
      "tool\u0000key",
    ] as const) {
      expect(
        validateAgentManifest({
          ...manifest(),
          spec: {
            ...manifest().spec,
            runtime: {
              ...manifest().spec.runtime,
              toolRequests: [
                {
                  ...manifest().spec.runtime.toolRequests[0],
                  idempotencyKey,
                },
              ],
            },
          },
        }),
      ).toMatchObject({ ok: false });
    }

    for (const sandbox of [
      { minMemoryMiB: MAX_AGENT_SANDBOX_MEMORY_MIB + 1, mode: "run-ephemeral" },
      { minVcpu: MAX_AGENT_SANDBOX_VCPU + 1, mode: "run-ephemeral" },
    ] as const) {
      expect(
        validateAgentManifest({
          ...manifest(),
          spec: { ...manifest().spec, sandbox },
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it("bounds model context settings and checkpoint mode in immutable releases", () => {
    expect(validateAgentManifest(manifest())).toMatchObject({ ok: true });
    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          runtime: { ...manifest().spec.runtime, modelInputTokenBudget: 1_023 },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          runtime: {
            ...manifest().spec.runtime,
            modelOutputTokenReserve: MAX_MODEL_OUTPUT_TOKEN_RESERVE + 1,
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          runtime: { ...manifest().spec.runtime, contextCheckpointMode: "always" },
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects incomplete or unbounded response depth policies", () => {
    const policy = {
      classifierInstructions: "Choose the response format.",
      detailedInstructions: "Develop the requested response.",
      minimumWords: 1,
      maximumWords: 8_192,
    };
    const decode = Schema.decodeUnknownSync(AgentResponseDepthPolicy, {
      onExcessProperty: "error",
    });
    expect(decode(policy)).toEqual(policy);
    for (const invalid of [
      { ...policy, classifierInstructions: "" },
      { ...policy, classifierInstructions: " surrounding whitespace " },
      { ...policy, detailedInstructions: "x".repeat(4_097) },
      { ...policy, defaultInstructions: "" },
      { ...policy, defaultInstructions: " surrounding whitespace " },
      { ...policy, defaultInstructions: "x".repeat(4_097) },
      { ...policy, defaultInstructions: null },
      { ...policy, defaultMaximumWords: 0 },
      { ...policy, defaultMaximumWords: 8_193 },
      { ...policy, defaultMaximumWords: 1.5 },
      { ...policy, defaultMaximumWords: Number.POSITIVE_INFINITY },
      { ...policy, defaultMaximumWords: "100" },
      { ...policy, minimumWords: 0 },
      { ...policy, maximumWords: 8_193 },
      { ...policy, minimumWords: 1.5 },
      { ...policy, maximumWords: Number.POSITIVE_INFINITY },
      { ...policy, minimumWords: undefined },
      { ...policy, unknown: true },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
    expect(
      decode({
        ...policy,
        classifierInstructions: "x".repeat(4_096),
        defaultInstructions: "x".repeat(4_096),
        detailedInstructions: "First paragraph.\n\nSecond paragraph.",
      }),
    ).toMatchObject({ minimumWords: 1, maximumWords: 8_192 });
  });

  it("rejects inverted response depth bounds before publishing immutable releases", () => {
    const policy = {
      classifierInstructions: "Choose the response format.",
      detailedInstructions: "Develop the requested response.",
      minimumWords: 100,
      maximumWords: 99,
    };
    expect(() => Schema.decodeUnknownSync(AgentResponseDepthPolicy)(policy)).toThrow();
    const withPolicy = (responseDepthPolicy: unknown) => ({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: { ...manifest().spec.runtime, responseDepthPolicy },
      },
    });
    expect(validateAgentManifest(withPolicy(policy))).toMatchObject({ ok: false });
    expect(
      validateAgentManifest(withPolicy({ ...policy, maximumWords: policy.minimumWords })),
    ).toMatchObject({ ok: true });
  });

  it("preserves independent default depth controls in immutable release identity", () => {
    const policy = {
      classifierInstructions: "Choose the response format.",
      detailedInstructions: "Develop the requested response.",
      minimumWords: 100,
      maximumWords: 100,
    };
    const withPolicy = (responseDepthPolicy: unknown) => ({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: { ...manifest().spec.runtime, responseDepthPolicy },
      },
    });
    const originalHash = agentManifestContentHash(withPolicy(policy));
    for (const controls of [
      { defaultInstructions: "Keep the response concise." },
      { defaultMaximumWords: 1 },
      {
        defaultInstructions: "First paragraph.\n\nSecond paragraph.",
        defaultMaximumWords: 8_192,
      },
    ]) {
      const configuredPolicy = { ...policy, ...controls };
      const result = validateAgentManifest(withPolicy(configuredPolicy));
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(JSON.parse(result.canonicalJson).spec.runtime.responseDepthPolicy).toEqual(
        configuredPolicy,
      );
      expect(result.contentHash).not.toBe(originalHash);
      expect(agentManifestContentHash(JSON.parse(result.canonicalJson))).toBe(result.contentHash);
    }
  });

  it("accepts only the supported explicit Gemma tool protocol", () => {
    const withProtocol = (modelToolProtocol: unknown) => ({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: { ...manifest().spec.runtime, modelToolProtocol },
      },
    });
    expect(validateAgentManifest(withProtocol("gemma4"))).toMatchObject({ ok: true });
    expect(validateAgentManifest(withProtocol("native"))).toMatchObject({ ok: false });
  });

  it("pins only screenshot tool-result images into release identity", () => {
    const withImages = (toolResultImages: unknown) => ({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: { ...manifest().spec.runtime, toolResultImages },
      },
    });
    const originalHash = agentManifestContentHash(manifest());
    const accepted = validateAgentManifest(withImages("screenshots"));
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.issues));
    expect(accepted.contentHash).not.toBe(originalHash);
    expect(validateAgentManifest(withImages("all"))).toMatchObject({ ok: false });
  });

  it("accepts the ingressAttachments opt-in and rejects the retired ingressImages key", () => {
    const withRuntime = (runtime: Record<string, unknown>) => ({
      ...manifest(),
      spec: { ...manifest().spec, runtime: { ...manifest().spec.runtime, ...runtime } },
    });
    expect(validateAgentManifest(withRuntime({ ingressAttachments: "attach" }))).toMatchObject({
      manifest: { spec: { runtime: { ingressAttachments: "attach" } } },
      ok: true,
    });
    expect(validateAgentManifest(withRuntime({ ingressImages: "attach" }))).toEqual({
      issues: [
        {
          code: "invalid_agent_manifest",
          message: 'Unexpected key with value "attach"\n  at ["spec"]["runtime"]["ingressImages"]',
          path: "/",
          severity: "error",
        },
      ],
      ok: false,
    });
  });

  it("bounds run-wide loop caps and keeps unset caps out of release identity", () => {
    const withRuntime = (runtime: Record<string, unknown>) => ({
      ...manifest(),
      spec: { ...manifest().spec, runtime: { ...manifest().spec.runtime, ...runtime } },
    });
    const originalHash = agentManifestContentHash(manifest());
    expect(agentManifestContentHash(withRuntime({}))).toBe(originalHash);
    for (const accepted of [
      { maxModelGenerations: 1 },
      { maxModelGenerations: 32 },
      { maxToolCalls: 1 },
      { maxToolCalls: 64 },
    ]) {
      const result = validateAgentManifest(withRuntime(accepted));
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.contentHash).not.toBe(originalHash);
    }
    for (const rejected of [
      { maxModelGenerations: 0 },
      { maxModelGenerations: 33 },
      { maxModelGenerations: 2.5 },
      { maxToolCalls: 0 },
      { maxToolCalls: 65 },
    ]) {
      expect(validateAgentManifest(withRuntime(rejected))).toMatchObject({ ok: false });
    }
  });

  it("accepts bounded OpenRouter model options", () => {
    const withOptions = (options: unknown) => ({
      ...manifest(),
      spec: { ...manifest().spec, model: { ...manifest().spec.model, options } },
    });
    for (const promptCache of ["system", "conversation"]) {
      const accepted = validateAgentManifest(
        withOptions({
          promptCache,
          provider: { allowFallbacks: false, order: ["anthropic"] },
          reasoningEffort: "high",
        }),
      );
      if (!accepted.ok) throw new Error(JSON.stringify(accepted.issues));
      expect(accepted.contentHash).not.toBe(agentManifestContentHash(manifest()));
    }
    for (const rejected of [
      { reasoningEffort: "maximum" },
      { promptCache: "all" },
      { provider: { order: [] } },
      { provider: { order: ["anthropic", "anthropic"] } },
      { provider: { order: ["Anthropic"] } },
      { provider: { region: "us" } },
    ]) {
      expect(validateAgentManifest(withOptions(rejected))).toMatchObject({ ok: false });
    }
  });

  it("rejects sandbox-only settings when isolation is disabled", () => {
    const result = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        sandbox: { minMemoryMiB: 1024, mode: "none" },
      },
    });

    expect(result).toMatchObject({
      issues: [{ code: "sandbox_setting_without_sandbox", path: "/spec/sandbox/minMemoryMiB" }],
      ok: false,
    });
  });

  it("accepts the MicroVM provider for thread-persistent sandboxes", () => {
    const withProvider = (provider?: "aws_lambda_microvm") =>
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          sandbox: { mode: "thread-persistent", ...(provider ? { provider } : {}) },
        },
      });

    expect(withProvider()).toMatchObject({ ok: true });
    expect(withProvider("aws_lambda_microvm")).toMatchObject({ ok: true });
  });

  it("allows sandbox file and computer tools only with thread-persistent sandboxes", () => {
    const withFileTools = (mode: "none" | "run-ephemeral" | "thread-persistent") =>
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          capabilities: {
            tools: [
              ...manifest().spec.capabilities.tools,
              ...[
                "sandbox.files.read",
                "sandbox.files.write",
                "sandbox.files.list",
                "computer.screenshot",
                "computer.action",
              ].map((name) => ({ name, required: true, requiredScopes: [] })),
            ],
          },
          sandbox: { mode },
        },
      });

    expect(withFileTools("thread-persistent")).toMatchObject({ ok: true });
    for (const mode of ["none", "run-ephemeral"] as const) {
      expect(withFileTools(mode)).toMatchObject({
        issues: [1, 2, 3, 4, 5].map((index) => ({
          code: "sandbox_file_tool_without_thread_sandbox",
          path: `/spec/capabilities/tools/${index}/name`,
        })),
        ok: false,
      });
    }
  });

  it("allows sandboxed browser tools only with a Lambda MicroVM sandbox", () => {
    const withBrowserTools = (sandbox: {
      readonly mode: "none" | "run-ephemeral" | "thread-persistent";
      readonly provider?: "aws_lambda_microvm";
    }) =>
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          capabilities: {
            tools: [
              ...manifest().spec.capabilities.tools,
              ...[
                "browser.capture_screenshot",
                "browser.screenshot.capture",
                "browser.session.execute",
                "browser.session.plan",
              ].map((name) => ({ name, required: true, requiredScopes: [] })),
            ],
          },
          sandbox,
        },
      });

    expect(withBrowserTools({ mode: "run-ephemeral" })).toMatchObject({ ok: true });
    expect(withBrowserTools({ mode: "thread-persistent" })).toMatchObject({ ok: true });
    expect(withBrowserTools({ mode: "none" })).toMatchObject({
      issues: [1, 2, 3].map((index) => ({
        code: "browser_tool_without_sandbox",
        path: `/spec/capabilities/tools/${index}/name`,
      })),
      ok: false,
    });
  });
});
