export function manifest() {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "example.assistant",
      name: "Example Assistant",
      version: "1.0.0",
    },
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
  } as const;
}
