import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  AgentDeploymentConfigV1,
  AgentManifestV1,
  JsonValue,
  agentManifestContentHash,
  canonicalAgentManifestJson,
  agentManifestAllowsTrigger,
  validateAgentManifest,
} from "./index.ts";
import { manifest } from "./manifest.fixture.ts";

describe("agent manifest", () => {
  it("decodes the versioned release and deployment contracts", () => {
    expect(Schema.decodeUnknownSync(AgentManifestV1)(manifest()).metadata.key).toBe(
      "example.assistant",
    );
    expect(
      Schema.decodeUnknownSync(AgentDeploymentConfigV1)({
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "records.read": {
            authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      }).toolAuthorizations?.["records.read"]?.authorizationId,
    ).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("accepts an explicit automatic memory-review policy", () => {
    const configured = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        memory: { mode: "agent", reviewMode: "auto-approve" },
      },
    } as const;

    expect(Schema.decodeUnknownSync(AgentManifestV1)(configured).spec.memory).toEqual({
      mode: "agent",
      reviewMode: "auto-approve",
    });
  });

  it("rejects automatic review when memory is disabled", () => {
    const result = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        memory: { mode: "off", reviewMode: "auto-approve" },
      },
    });

    expect(result).toMatchObject({
      issues: [
        {
          code: "memory_review_without_memory",
          path: "/spec/memory/reviewMode",
        },
      ],
      ok: false,
    });
  });

  it("names platform skills and counts them against the skill limit", () => {
    const withPlatformSkills = (platformSkills: readonly string[], skillCount: number) =>
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          platformSkills,
          skills: Array.from({ length: skillCount }, (_, index) => `Skill ${index}.`),
        },
      });

    expect(withPlatformSkills(["computer-use", "app-builder"], 30)).toMatchObject({ ok: true });
    expect(withPlatformSkills(["computer-use", "app-builder"], 31)).toMatchObject({
      issues: [{ code: "too_many_skills", path: "/spec/skills" }],
      ok: false,
    });
    expect(withPlatformSkills(["computer"], 0)).toMatchObject({ ok: false });
    expect(withPlatformSkills(["computer-use", "computer-use"], 0)).toMatchObject({ ok: false });
  });

  it("produces stable canonical JSON and hashes regardless of object key order", () => {
    const original = manifest();
    const reordered = {
      metadata: original.metadata,
      spec: original.spec,
      kind: original.kind,
      apiVersion: original.apiVersion,
    };

    expect(canonicalAgentManifestJson(reordered)).toBe(canonicalAgentManifestJson(original));
    expect(agentManifestContentHash(reordered)).toBe(agentManifestContentHash(original));
    expect(agentManifestContentHash(original)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("returns structured semantic validation issues", () => {
    const result = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        capabilities: { tools: [] },
      },
    });

    expect(result).toMatchObject({
      issues: [
        {
          code: "undeclared_tool_request",
          path: "/spec/runtime/toolRequests/0/toolName",
        },
      ],
      ok: false,
    });
  });

  it("requires model-native tools to be explicitly allowlisted capabilities", () => {
    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          runtime: {
            ...manifest().spec.runtime,
            modelTools: ["records.read"],
          },
        },
      }),
    ).toMatchObject({ ok: true });

    expect(
      validateAgentManifest({
        ...manifest(),
        spec: {
          ...manifest().spec,
          runtime: {
            ...manifest().spec.runtime,
            modelTools: ["undeclared.read"],
          },
        },
      }),
    ).toMatchObject({
      issues: [
        {
          code: "undeclared_model_tool",
          path: "/spec/runtime/modelTools/0",
        },
      ],
      ok: false,
    });
  });

  it("refuses a release that declares the platform-managed attachment.read tool", () => {
    const declared = manifest();
    expect(
      validateAgentManifest({
        ...declared,
        spec: {
          ...declared.spec,
          capabilities: {
            tools: [
              ...declared.spec.capabilities.tools,
              { name: "attachment.read", required: false, requiredScopes: [] },
            ],
          },
          runtime: { ...declared.spec.runtime, modelTools: ["attachment.read"] },
        },
      }),
    ).toMatchObject({
      issues: [
        {
          code: "platform_managed_tool",
          message: "attachment.read is added by the platform when a run has a readable document.",
          path: "/spec/capabilities/tools/1/name",
        },
        {
          code: "platform_managed_tool",
          message: "attachment.read is added by the platform when a run has a readable document.",
          path: "/spec/runtime/modelTools/0",
        },
      ],
      ok: false,
    });
  });

  it("accepts provider-defined OAuth scope strings as opaque bounded values", () => {
    const result = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        capabilities: {
          tools: [
            {
              authorization: "workspace",
              name: "records.read",
              required: true,
              requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly", "Mail.Read"],
            },
          ],
        },
        runtime: {
          ...manifest().spec.runtime,
          toolRequests: [
            {
              ...manifest().spec.runtime.toolRequests[0],
              requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly", "Mail.Read"],
            },
          ],
        },
      },
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("accepts active catalog tool names and enforces declared triggers", () => {
    const value = {
      ...manifest(),
      spec: {
        ...manifest().spec,
        capabilities: {
          tools: [
            {
              authorization: "workspace",
              name: "slack.postMessage",
              required: true,
              requiredScopes: ["chat:write"],
            },
          ],
        },
        runtime: undefined,
        triggers: ["email", "schedule", "workflow"],
      },
    };
    const result = validateAgentManifest(value);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected a valid manifest.");
    expect(agentManifestAllowsTrigger(result.manifest, "email")).toBe(true);
    expect(agentManifestAllowsTrigger(result.manifest, "schedule")).toBe(true);
    expect(agentManifestAllowsTrigger(result.manifest, "workflow")).toBe(true);
    expect(agentManifestAllowsTrigger(result.manifest, "api")).toBe(false);
  });

  it("rejects undeclared fields instead of omitting them from the release hash", () => {
    expect(
      validateAgentManifest({
        ...manifest(),
        consumerSpecificBehavior: true,
      }),
    ).toMatchObject({
      issues: [{ code: "invalid_agent_manifest", path: "/" }],
      ok: false,
    });
  });

  it("rejects whitespace-only instructions and unpersistable JSON integers", () => {
    expect(
      validateAgentManifest({
        ...manifest(),
        spec: { ...manifest().spec, instructions: "   \n\t" },
      }),
    ).toMatchObject({ ok: false });
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
                input: { unsafeInteger: Number.MAX_SAFE_INTEGER + 1 },
              },
            ],
          },
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects oversized, deeply nested, and aggregate-unpersistable manifests", () => {
    let deeplyNestedJson: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 64; depth += 1) deeplyNestedJson = { value: deeplyNestedJson };
    expect(() => Schema.decodeUnknownSync(JsonValue)(deeplyNestedJson)).toThrow();
    const jsonCodec = Schema.toCodecJson(JsonValue);
    expect(() => Schema.decodeUnknownSync(jsonCodec)(deeplyNestedJson)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(jsonCodec)({ unsafeInteger: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(jsonCodec)({ nested: [1, true, null] })).toEqual({
      nested: [1, true, null],
    });

    const oversizedInput = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: {
          ...manifest().spec.runtime,
          toolRequests: [
            {
              ...manifest().spec.runtime.toolRequests[0],
              input: { value: "x".repeat(33 * 1_024) },
            },
          ],
        },
      },
    });
    expect(oversizedInput).toMatchObject({
      issues: [expect.objectContaining({ code: "tool_request_input_too_large" })],
      ok: false,
    });

    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 17; index += 1) nested = { nested };
    const deepInput = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        runtime: {
          ...manifest().spec.runtime,
          toolRequests: [
            {
              ...manifest().spec.runtime.toolRequests[0],
              input: nested,
            },
          ],
        },
      },
    });
    expect(deepInput).toMatchObject({
      issues: [expect.objectContaining({ code: "tool_request_input_too_deep" })],
      ok: false,
    });

    let hostile: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index += 1) hostile = { nested: hostile };
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
                input: hostile,
              },
            ],
          },
        },
      }),
    ).toMatchObject({ issues: [expect.any(Object)], ok: false });

    const aggregate = validateAgentManifest({
      ...manifest(),
      spec: {
        ...manifest().spec,
        instructions: "i".repeat(128 * 1_024),
        skills: Array.from({ length: 25 }, () => "s".repeat(8 * 1_024)),
      },
    });
    expect(aggregate).toMatchObject({
      issues: [expect.objectContaining({ code: "agent_manifest_too_large" })],
      ok: false,
    });
  });

  it("validates deployment bindings against release capabilities", async () => {
    const { validateAgentDeploymentConfig } = await import("./index.ts");
    const valid = validateAgentDeploymentConfig(
      {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "records.read": {
            authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      },
      manifest(),
    );
    expect(valid).toMatchObject({ ok: true });

    const invalid = validateAgentDeploymentConfig(
      {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "undeclared.read": {
            authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      },
      manifest(),
    );
    expect(invalid).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "undeclared_tool_authorization" }),
        expect.objectContaining({ code: "missing_tool_authorization" }),
      ]),
      ok: false,
    });

    const authorizationNotAllowed = validateAgentDeploymentConfig(
      {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "records.read": {
            authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      },
      {
        ...manifest(),
        spec: {
          ...manifest().spec,
          capabilities: {
            tools: [
              {
                authorization: "none",
                name: "records.read",
                required: true,
                requiredScopes: ["records:read"],
              },
            ],
          },
        },
      },
    );
    expect(authorizationNotAllowed).toMatchObject({
      issues: [expect.objectContaining({ code: "tool_authorization_not_allowed" })],
      ok: false,
    });

    const prototypeNamedBinding = validateAgentDeploymentConfig(
      {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: {
          "records.read": {
            authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
      },
      {
        ...manifest(),
        spec: {
          ...manifest().spec,
          capabilities: {
            tools: [
              ...manifest().spec.capabilities.tools,
              {
                authorization: "workspace",
                name: "constructor",
                required: true,
                requiredScopes: [],
              },
            ],
          },
        },
      },
    );
    expect(prototypeNamedBinding).toMatchObject({
      issues: [
        expect.objectContaining({
          code: "missing_tool_authorization",
          path: "/toolAuthorizations/constructor",
        }),
      ],
      ok: false,
    });
  });
});
