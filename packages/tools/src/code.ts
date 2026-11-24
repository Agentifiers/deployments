import type { ToolAdapterDefinition } from "./types.ts";

export const CODE_EXECUTE_TOOL_NAME = "code.execute" as const;
export const CODE_EXECUTE_MAX_SOURCE_BYTES = 20 * 1024;
export const CODE_EXECUTE_DEFAULT_TIMEOUT_MS = 30_000;
export const CODE_EXECUTE_MAX_TIMEOUT_MS = 50_000;

export const codeExecuteToolDefinition = {
  defaultPolicyAction: "allow",
  description:
    "Execute bounded Bash, JavaScript, or Python source in an isolated sandbox and return its output. With a thread-persistent sandbox, files under /workspace persist across calls and runs in the same thread.",
  effect: "execute",
  egress: "public",
  execution: { adapterKey: CODE_EXECUTE_TOOL_NAME, type: "builtin" },
  inputSchema: {
    additionalProperties: false,
    properties: {
      code: {
        description: "Source code limited to 20 KiB after UTF-8 encoding.",
        maxLength: CODE_EXECUTE_MAX_SOURCE_BYTES,
        minLength: 1,
        type: "string",
      },
      language: { enum: ["bash", "javascript", "python"], type: "string" },
      timeoutMs: {
        maximum: CODE_EXECUTE_MAX_TIMEOUT_MS,
        minimum: 100,
        type: "integer",
      },
    },
    required: ["code", "language"],
    type: "object",
  },
  providerOutboundMutation: true,
  requiredScopes: [],
  status: "active",
  toolName: CODE_EXECUTE_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const codeToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  codeExecuteToolDefinition,
];
