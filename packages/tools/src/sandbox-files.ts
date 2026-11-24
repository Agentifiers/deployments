import type { ToolAdapterDefinition } from "./types.ts";

export const SANDBOX_FILES_READ_TOOL_NAME = "sandbox.files.read" as const;
export const SANDBOX_FILES_WRITE_TOOL_NAME = "sandbox.files.write" as const;
export const SANDBOX_FILES_LIST_TOOL_NAME = "sandbox.files.list" as const;
export const SANDBOX_FILE_TOOL_NAMES = [
  SANDBOX_FILES_READ_TOOL_NAME,
  SANDBOX_FILES_WRITE_TOOL_NAME,
  SANDBOX_FILES_LIST_TOOL_NAME,
] as const;
export const SANDBOX_FILES_PATH_MAX_CHARACTERS = 1024;
export const SANDBOX_FILES_READ_DEFAULT_BYTES = 32 * 1024;
export const SANDBOX_FILES_READ_MAX_BYTES = 64 * 1024;
export const SANDBOX_FILES_WRITE_MAX_BYTES = 96 * 1024;
export const SANDBOX_FILES_LIST_DEFAULT_ENTRIES = 200;
export const SANDBOX_FILES_LIST_MAX_ENTRIES = 500;

const sandboxFilePath = {
  description:
    "Absolute path under /workspace, or a path relative to /workspace. Must stay within /workspace.",
  maxLength: SANDBOX_FILES_PATH_MAX_CHARACTERS,
  minLength: 1,
  type: "string",
} as const;

export const sandboxFilesReadToolDefinition = {
  defaultPolicyAction: "allow",
  description:
    "Read a UTF-8 text file from this thread's persistent sandbox workspace (/workspace).",
  effect: "read",
  egress: "public",
  execution: { adapterKey: SANDBOX_FILES_READ_TOOL_NAME, type: "builtin" },
  inputSchema: {
    additionalProperties: false,
    properties: {
      maxBytes: {
        description: "Maximum bytes to return; defaults to 32 KiB.",
        maximum: SANDBOX_FILES_READ_MAX_BYTES,
        minimum: 1,
        type: "integer",
      },
      path: sandboxFilePath,
    },
    required: ["path"],
    type: "object",
  },
  requiredScopes: [],
  status: "active",
  toolName: SANDBOX_FILES_READ_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const sandboxFilesWriteToolDefinition = {
  defaultPolicyAction: "allow",
  description:
    "Create or replace a UTF-8 text file in this thread's persistent sandbox workspace (/workspace), creating parent directories.",
  effect: "write",
  egress: "public",
  execution: { adapterKey: SANDBOX_FILES_WRITE_TOOL_NAME, type: "builtin" },
  inputSchema: {
    additionalProperties: false,
    properties: {
      content: {
        description: "File content limited to 96 KiB after UTF-8 encoding.",
        maxLength: SANDBOX_FILES_WRITE_MAX_BYTES,
        type: "string",
      },
      path: sandboxFilePath,
    },
    required: ["path", "content"],
    type: "object",
  },
  providerOutboundMutation: true,
  requiredScopes: [],
  status: "active",
  toolName: SANDBOX_FILES_WRITE_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const sandboxFilesListToolDefinition = {
  defaultPolicyAction: "allow",
  description:
    "List files and directories in this thread's persistent sandbox workspace (/workspace).",
  effect: "read",
  egress: "public",
  execution: { adapterKey: SANDBOX_FILES_LIST_TOOL_NAME, type: "builtin" },
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: {
        description: "Maximum entries to return; defaults to 200.",
        maximum: SANDBOX_FILES_LIST_MAX_ENTRIES,
        minimum: 1,
        type: "integer",
      },
      path: { ...sandboxFilePath, description: "Directory to list; defaults to /workspace." },
      recursive: {
        description: "List nested entries; defaults to false.",
        type: "boolean",
      },
    },
    type: "object",
  },
  requiredScopes: [],
  status: "active",
  toolName: SANDBOX_FILES_LIST_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const sandboxFileToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  sandboxFilesReadToolDefinition,
  sandboxFilesWriteToolDefinition,
  sandboxFilesListToolDefinition,
];
