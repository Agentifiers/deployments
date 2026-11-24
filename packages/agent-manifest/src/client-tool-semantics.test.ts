import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { AgentManifestV1, clientToolTriggerIssues } from "./index.ts";

function manifest(triggers: readonly string[] | undefined) {
  return Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          { name: "records.read", required: true, requiredScopes: [] },
          { name: "weather.local", required: true, requiredScopes: [] },
        ],
      },
      instructions: "Answer using the caller's device.",
      memory: { mode: "workspace" },
      model: { id: "openrouter/default" },
      runtime: {
        contextCheckpointMode: "auto",
        modelInputTokenBudget: 32_000,
        modelOutputTokenReserve: 2_000,
        recentMessageCharacterBudget: 64_000,
      },
      sandbox: { mode: "none" },
      skills: [],
      ...(triggers ? { triggers } : {}),
    },
  });
}

describe("client tool trigger semantics", () => {
  const clientTools = new Set(["weather.local"]);

  it("accepts client tools on manifests limited to interactive api triggers", () => {
    expect(clientToolTriggerIssues(manifest(["api"]), clientTools)).toEqual([]);
  });

  it.each([["schedule"], ["heartbeat"], ["email"], ["chat"], ["webhook"], ["workflow"]])(
    "rejects client tools when the %s trigger is allowed",
    (trigger) => {
      expect(clientToolTriggerIssues(manifest(["api", trigger]), clientTools)).toEqual([
        expect.objectContaining({
          code: "client_tool_on_autonomous_trigger",
          path: "/spec/capabilities/tools/1",
        }),
      ]);
    },
  );

  it("treats an omitted trigger list as allowing autonomous triggers", () => {
    expect(clientToolTriggerIssues(manifest(undefined), clientTools)).toHaveLength(1);
  });

  it("ignores manifests without client tools", () => {
    expect(clientToolTriggerIssues(manifest(["schedule"]), new Set())).toEqual([]);
  });
});
