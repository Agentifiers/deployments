import { AgentManifestV1 } from "@deployments-ai/agent-manifest/schema";
import { Schema } from "effect";

export const ULID = (tail: string) => `01K${tail.padStart(23, "0")}`;
export const GRANT_A = ULID("GA");
export const GRANT_B = ULID("GB");
export const POLICY = ULID("P1");

export function manifest(
  tools: readonly { name: string; required?: boolean; workspace?: boolean }[],
  agents: readonly { key: string; required: boolean }[] = [],
): AgentManifestV1 {
  return Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "fixture", name: "Fixture", version: "1.0.0" },
    spec: {
      ...(agents.length > 0
        ? {
            agents: agents.map(({ key, required }) => ({
              agentKey: `${key}-agent`,
              description: `Fixture ${key}.`,
              key,
              required,
            })),
          }
        : {}),
      capabilities: {
        tools: [
          ...tools.map(({ name, required = false, workspace = true }) => ({
            ...(workspace ? { authorization: "workspace" } : {}),
            name,
            required,
            requiredScopes: [],
          })),
          ...(agents.length > 0
            ? [{ name: "agent.delegate", required: true, requiredScopes: [] }]
            : []),
        ],
      },
      instructions: "Fixture.",
      model: { id: "openrouter/default" },
      triggers: ["api"],
      sandbox: { mode: "none" },
    },
  });
}
