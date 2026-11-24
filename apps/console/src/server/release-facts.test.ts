import { describe, expect, test } from "bun:test";
import { AgentReleaseResponse } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { releaseFacts } from "./release-facts.ts";

const id = (label: string) => `01K${label.padEnd(23, "0")}`;

function release(spec: { capabilities?: unknown; model: unknown }) {
  return Schema.decodeUnknownSync(AgentReleaseResponse)({
    agentDefinitionId: id("DEF"),
    contentHash: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    createdByPrincipalId: id("P"),
    environmentId: id("ENV"),
    id: id("RE1"),
    manifest: {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
      spec: {
        ...spec,
        instructions: "Answer using the available records.",
        sandbox: { mode: "none" },
      },
    },
    organizationId: id("0RG"),
    projectId: id("PRJ"),
    releaseNumber: 3,
    status: "archived",
    version: 1,
  });
}

describe("releaseFacts", () => {
  test("keeps the models and the workspace-bound tools, nothing else from the manifest", () => {
    const tool = (name: string, required: boolean, authorization?: "none" | "workspace") => ({
      ...(authorization ? { authorization } : {}),
      name,
      required,
      requiredScopes: [],
    });
    expect(
      releaseFacts(
        release({
          capabilities: {
            tools: [
              tool("records.read", true, "workspace"),
              tool("records.write", false, "workspace"),
              tool("clock.now", true, "none"),
              tool("weather.lookup", true),
            ],
          },
          model: { fallbackIds: ["openrouter/fallback"], id: "openrouter/default" },
        }),
      ),
    ).toEqual({
      agentDefinitionId: id("DEF"),
      id: id("RE1"),
      models: { fallbacks: ["openrouter/fallback"], primary: "openrouter/default" },
      releaseNumber: 3,
      status: "archived",
      workspaceTools: [
        { name: "records.read", required: true },
        { name: "records.write", required: false },
      ],
    });
  });

  test("a release without tools or fallbacks has empty lists", () => {
    expect(releaseFacts(release({ model: { id: "openrouter/default" } }))).toMatchObject({
      models: { fallbacks: [], primary: "openrouter/default" },
      workspaceTools: [],
    });
  });
});
