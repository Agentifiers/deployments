import { TENANCY_PATHS } from "@deployments-ai/api-contract/routes";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  description,
  id,
  json,
  list,
  mutate,
  name,
  requiredText,
  requiredJson,
  requiredNumber,
  show,
  text,
  flag,
} from "./catalog-helpers.ts";
import {
  agentDeploymentCommandCatalog,
  agentReleaseId,
  expectedVersion,
  tenancyPagination,
} from "./catalog-agent-deployments.ts";
import { threadErasureActions } from "./catalog-erasures.ts";

const expectedDefinitionVersion = {
  ...requiredNumber("Expected agent definition version"),
  field: "expectedDefinitionVersion",
};

const runtimePagination = {
  limitField: "limit",
  maxLimit: 100,
  target: "query",
} as const;
const administrationPagination = {
  limitField: "limit",
  maxLimit: 100,
  target: "query",
} as const;

export const agentCommandCatalog: CommandCatalog = {
  agent: {
    summary: "Agent definitions and lifecycle shortcuts",
    actions: {
      create: create(
        TENANCY_PATHS.agentDefinitions,
        "environment",
        {
          manifest: requiredJson("Agent manifest JSON"),
        },
        "Create an agent definition",
      ),
      list: list(
        TENANCY_PATHS.agentDefinitions,
        "environment",
        "List agent definitions",
        tenancyPagination,
      ),
      show: show(TENANCY_PATHS.agentDefinitions, "environment", "Show an agent definition"),
      update: mutate(
        "PATCH",
        TENANCY_PATHS.agentDefinitions,
        "environment",
        "Update an agent definition",
        {
          id,
          manifest: requiredJson("Agent manifest JSON"),
          "expected-version": expectedVersion,
        },
      ),
      release: action({
        summary: "Create an immutable agent release",
        method: "POST",
        path: `${TENANCY_PATHS.agentDefinitions}/:id/releases`,
        scope: "environment",
        output: "detail",
        args: { id, "expected-version": expectedDefinitionVersion },
        idempotent: true,
      }),
      deploy: action({
        summary: "Deploy an agent release",
        method: "POST",
        path: TENANCY_PATHS.agentDeployments,
        scope: "environment",
        output: "detail",
        args: {
          release: agentReleaseId,
          "desired-state": text("running or paused"),
          "runtime-config": json("Deployment runtime configuration"),
        },
        idempotent: true,
      }),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.agentDefinitions,
        "environment",
        "Archive an agent definition",
        { id, "expected-version": expectedVersion },
      ),
    },
  },
  profile: {
    summary: "Reusable agent profiles",
    actions: {
      create: create(
        "/v1/agent-profiles",
        "environment",
        { name, description, configuration: json("Profile configuration") },
        "Create an agent profile",
      ),
      list: list("/v1/agent-profiles", "environment", "List agent profiles"),
      show: show("/v1/agent-profiles", "environment", "Show an agent profile"),
      update: mutate("PATCH", "/v1/agent-profiles", "environment", "Update an agent profile", {
        id,
        name: text("New profile name"),
        configuration: json("Profile configuration"),
      }),
      archive: mutate("DELETE", "/v1/agent-profiles", "environment", "Archive an agent profile"),
    },
  },
  ...agentDeploymentCommandCatalog,
  "mcp-server": {
    summary: "Remote MCP servers",
    actions: {
      create: action({
        ...create(
          "/v1/mcp-servers",
          "environment",
          {
            name,
            "endpoint-origin": requiredText("HTTPS endpoint origin"),
            "endpoint-path": requiredText("Endpoint path"),
            tools: { ...requiredJson("Remote tool allowlist"), bodyField: "toolAllowlist" },
            auth: text("MCP authentication JSON (prefer env or file source)", "control"),
            "auth-env": text("Environment variable containing MCP authentication JSON", "control"),
            "auth-file": text("File containing MCP authentication JSON", "control"),
          },
          "Register an MCP server",
        ),
        secretInputs: [
          {
            directArgument: "auth",
            environmentArgument: "auth-env",
            fileArgument: "auth-file",
            bodyField: "auth",
            format: "json",
            required: false,
          },
        ],
      }),
      list: list("/v1/mcp-servers", "environment", "List MCP servers", administrationPagination),
      show: show("/v1/mcp-servers", "environment", "Show an MCP server"),
      update: action({
        ...mutate("PATCH", "/v1/mcp-servers", "environment", "Update an MCP server", {
          id,
          "expected-version": expectedVersion,
          name: text("New server name"),
          "endpoint-origin": text("New HTTPS endpoint origin"),
          "endpoint-path": text("New endpoint path"),
          tools: { ...json("Remote tool allowlist"), bodyField: "toolAllowlist" },
          auth: text("Replacement MCP authentication JSON (prefer env or file source)", "control"),
          "auth-env": text(
            "Environment variable containing replacement MCP authentication JSON",
            "control",
          ),
          "auth-file": text("File containing replacement MCP authentication JSON", "control"),
        }),
        secretInputs: [
          {
            directArgument: "auth",
            environmentArgument: "auth-env",
            fileArgument: "auth-file",
            bodyField: "auth",
            format: "json",
            required: false,
          },
        ],
      }),
      discover: action({
        summary: "Verify and discover MCP tools",
        method: "POST",
        path: "/v1/mcp-servers/:id/discover",
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: { id },
      }),
      archive: mutate("DELETE", "/v1/mcp-servers", "environment", "Archive an MCP server"),
    },
  },
  "mcp-connection": {
    summary: "MCP runtime connections",
    actions: {
      create: create(
        "/v1/mcp-connections",
        "environment",
        { server: { ...requiredText("MCP server ID"), bodyField: "mcpServerId" } },
        "Create an MCP connection",
      ),
      list: list(
        "/v1/mcp-connections",
        "environment",
        "List MCP connections",
        administrationPagination,
      ),
      show: show("/v1/mcp-connections", "environment", "Show an MCP connection"),
      revoke: mutate("DELETE", "/v1/mcp-connections", "environment", "Revoke an MCP connection"),
    },
  },
  extension: {
    summary: "Custom MCP and callback tools",
    actions: {
      create: action({
        ...create(
          "/v1/extensions",
          "environment",
          {
            name,
            description: {
              ...requiredText("Extension tool description"),
              bodyField: "description",
            },
            effect: { ...requiredText("read, write, or execute"), bodyField: "effect" },
            execution: {
              ...requiredJson("MCP or callback execution binding"),
              bodyField: "execution",
            },
            "input-schema": { ...requiredJson("JSON input schema"), bodyField: "inputSchema" },
            provider: { ...text("Provider key"), bodyField: "providerKey" },
            scopes: { ...requiredJson("Required scopes"), bodyField: "requiredScopes" },
            "default-action": {
              ...requiredText("allow, require_approval, or deny"),
              bodyField: "defaultPolicyAction",
            },
            "callback-secret": text(
              "Callback bearer secret (prefer env or file source)",
              "control",
            ),
            "callback-secret-env": text(
              "Environment variable containing the callback bearer secret",
              "control",
            ),
            "callback-secret-file": text("File containing the callback bearer secret", "control"),
          },
          "Register an extension tool",
        ),
        secretInputs: [
          {
            directArgument: "callback-secret",
            environmentArgument: "callback-secret-env",
            fileArgument: "callback-secret-file",
            bodyField: "callbackSecret",
            required: false,
          },
        ],
      }),
      list: list("/v1/extensions", "environment", "List extension tools", administrationPagination),
      show: action({
        summary: "Show an extension tool",
        method: "GET",
        path: "/v1/extensions/:toolName",
        scope: "environment",
        output: "detail",
        args: { name: { ...requiredText("Tool name"), field: "toolName", target: "path" } },
      }),
      update: action({
        summary: "Update an extension tool",
        method: "PATCH",
        path: "/v1/extensions/:toolName",
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          name: { ...requiredText("Tool name"), field: "toolName", target: "path" },
          "expected-version": expectedVersion,
          description: { ...description, bodyField: "description" },
          effect: { ...text("read, write, or execute"), bodyField: "effect" },
          execution: { ...json("MCP or callback execution binding"), bodyField: "execution" },
          "input-schema": { ...json("JSON input schema"), bodyField: "inputSchema" },
          provider: { ...text("Provider key"), bodyField: "providerKey" },
          scopes: { ...json("Required scopes"), bodyField: "requiredScopes" },
          "default-action": {
            ...text("allow, require_approval, or deny"),
            bodyField: "defaultPolicyAction",
          },
          "callback-secret": text(
            "Replacement callback bearer secret (prefer env or file source)",
            "control",
          ),
          "callback-secret-env": text(
            "Environment variable containing the replacement callback bearer secret",
            "control",
          ),
          "callback-secret-file": text(
            "File containing the replacement callback bearer secret",
            "control",
          ),
        },
        secretInputs: [
          {
            directArgument: "callback-secret",
            environmentArgument: "callback-secret-env",
            fileArgument: "callback-secret-file",
            bodyField: "callbackSecret",
            required: false,
          },
        ],
      }),
      archive: action({
        summary: "Archive an extension tool",
        method: "DELETE",
        path: "/v1/extensions/:toolName",
        scope: "environment",
        output: "detail",
        idempotent: true,
        destructive: true,
        args: { name: { ...requiredText("Tool name"), field: "toolName", target: "path" } },
      }),
    },
  },
  thread: {
    summary: "Conversation threads",
    actions: {
      list: {
        ...list("/v1/threads", "environment", "List conversation threads", runtimePagination),
        args: {
          "execution-binding-id": text("Preview or evaluation execution binding ID", "query"),
        },
        listField: "threads",
      },
      create: action({
        summary: "Create a conversation thread",
        method: "POST",
        path: "/v1/threads",
        scope: "environment",
        output: "detail",
        args: {
          "agent-deployment-id": requiredText("Agent deployment ID"),
          "end-user-id": text("Your ID for the end user the thread belongs to"),
          title: text("Thread title"),
          "workspace-id": text("Workspace ID"),
        },
      }),
      show: action({
        summary: "Show a thread",
        method: "GET",
        path: "/v1/threads/:threadId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "threadId" },
        },
      }),
      archive: action({
        summary: "Archive a conversation thread",
        method: "POST",
        path: "/v1/threads/:threadId/archive",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "threadId" },
        },
        destructive: true,
      }),
      ...threadErasureActions,
      messages: action({
        summary: "List thread messages",
        method: "GET",
        path: "/v1/threads/:threadId/messages",
        scope: "environment",
        output: "list",
        listField: "messages",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          id: { ...id, field: "threadId" },
        },
      }),
      session: action({
        summary: "Create a bounded thread stream session",
        method: "POST",
        path: "/v1/threads/:threadId/stream-sessions",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "threadId" },
        },
        sensitiveOutput: true,
        sensitiveOutputFields: ["accessToken"],
      }),
    },
  },
  message: {
    summary: "Persisted thread messages",
    actions: {
      list: action({
        summary: "List messages for a thread",
        method: "GET",
        path: "/v1/threads/:threadId/messages",
        scope: "environment",
        output: "list",
        listField: "messages",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
            definition: {
              type: "positional",
              description: "Thread ID",
              required: true,
            },
          },
        },
      }),
    },
  },
  run: {
    summary: "Agent execution and timelines",
    actions: {
      list: action({
        summary: "List agent runs in the environment, optionally for one deployment or binding",
        method: "GET",
        path: "/v1/runs",
        scope: "environment",
        output: "list",
        listField: "runs",
        pagination: runtimePagination,
        args: {
          "agent-deployment-id": text("Agent deployment ID", "query"),
          "execution-binding-id": text("Preview or evaluation execution binding ID", "query"),
          "execution-purpose": text("Execution purpose: customer, evaluation, or preview", "query"),
          "created-after": text("Earliest creation timestamp", "query"),
          "created-before": text("Latest creation timestamp", "query"),
          status: text("Run status", "query"),
          thread: { ...text("Thread ID", "query"), field: "threadId" },
          release: { ...text("Agent release ID", "query"), field: "agentReleaseId" },
        },
      }),
      search: action({
        summary: "Search agent runs",
        method: "POST",
        path: "/v1/runs/search",
        scope: "environment",
        output: "list",
        listField: "runs",
        pagination: { ...runtimePagination, target: "body" },
        args: {
          "agent-deployment-id": text("Agent deployment ID"),
          "execution-binding-id": text("Preview or evaluation execution binding ID"),
          "execution-purpose": text("Execution purpose: customer, evaluation, or preview"),
          "created-after": text("Earliest creation timestamp"),
          "created-before": text("Latest creation timestamp"),
          status: text("Run status"),
          thread: { ...text("Thread ID"), bodyField: "threadId" },
          release: { ...text("Agent release ID"), field: "agentReleaseId" },
        },
      }),
      create: action({
        summary: "Create an agent run",
        method: "POST",
        path: "/v1/agent-deployments/:agentDeploymentId/runs",
        scope: "environment",
        output: "detail",
        args: {
          agent: {
            ...requiredText("Agent deployment ID", "path"),
            field: "agentDeploymentId",
          },
          thread: { ...text("Thread ID"), bodyField: "threadId" },
          message: {
            ...requiredText("Message input"),
            bodyField: "content",
          },
          title: text("Thread title"),
          "workspace-id": text("Workspace ID"),
          "rebase-release": flag("Drop the thread's sticky release and re-select"),
        },
        idempotent: true,
      }),
      get: action({
        summary: "Show a run by ID without its thread",
        method: "GET",
        path: "/v1/runs/:runId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "runId" },
        },
      }),
      logs: action({
        summary: "List what the runtime logged while executing a run",
        method: "GET",
        path: "/v1/runs/:runId/logs",
        scope: "environment",
        output: "list",
        listField: "logs",
        pagination: { limitField: "limit", maxLimit: 500, target: "query" },
        args: {
          id: { ...id, field: "runId" },
          level: text("Minimum level: debug, info, warn, or error", "query"),
          source: text("Source: runtime, model, tool, sandbox, or hosted-code", "query"),
          "tool-call": { ...text("Tool call ID", "query"), field: "toolCallId" },
          from: text("Earliest line timestamp", "query"),
          to: text("Latest line timestamp, exclusive", "query"),
        },
      }),
      show: action({
        summary: "Show a run within its thread",
        method: "GET",
        path: "/v1/threads/:threadId/runs/:runId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "runId" },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
        },
      }),
      message: action({
        summary: "Show the finalized assistant message for a run",
        method: "GET",
        path: "/v1/threads/:threadId/runs/:runId/message",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "runId" },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
        },
      }),
      "reserve-message-publication": action({
        summary: "Reserve conversation order before an external automation delivery",
        method: "POST",
        path: "/v1/threads/:threadId/runs/:runId/message/publication-reservations",
        scope: "environment",
        output: "detail",
        idempotent: true,
        requiresExplicitIdempotencyKey: true,
        args: {
          id: { ...id, field: "runId" },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
          message: {
            ...requiredText("Delivered message content"),
            bodyField: "content",
          },
        },
      }),
      "publish-message": action({
        summary: "Publish a confirmed externally delivered automation message",
        method: "POST",
        path: "/v1/threads/:threadId/runs/:runId/message/publications",
        scope: "environment",
        output: "detail",
        idempotent: true,
        requiresExplicitIdempotencyKey: true,
        args: {
          id: { ...id, field: "runId" },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
          message: {
            ...requiredText("Delivered message content"),
            bodyField: "content",
          },
        },
      }),
      "release-message-publication": action({
        summary: "Release an uncertain external automation delivery reservation",
        method: "POST",
        path: "/v1/threads/:threadId/runs/:runId/message/publication-releases",
        scope: "environment",
        output: "detail",
        idempotent: true,
        requiresExplicitIdempotencyKey: true,
        args: {
          id: { ...id, field: "runId" },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
          message: {
            ...requiredText("Delivered message content"),
            bodyField: "content",
          },
        },
      }),
      cancel: action({
        summary: "Cancel an agent run",
        method: "POST",
        path: "/v1/runs/:runId/cancel",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "runId" },
        },
        destructive: true,
      }),
      retry: action({
        summary: "Retry a failed agent run",
        method: "POST",
        path: "/v1/runs/:runId/retry",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "runId" },
        },
        destructive: true,
      }),
      replay: action({
        summary: "Replay an agent run",
        method: "POST",
        path: "/v1/runs/:runId/replay",
        scope: "environment",
        output: "action",
        args: {
          id: { ...id, field: "runId" },
        },
        idempotent: true,
        destructive: true,
      }),
      tail: action({
        summary: "Tail a run timeline",
        method: "GET",
        path: "/v1/threads/:threadId/stream",
        scope: "environment",
        output: "stream",
        args: {
          id: {
            definition: {
              type: "positional",
              description: "Run ID",
              required: true,
            },
            target: "control",
          },
          thread: {
            ...requiredText("Thread ID", "path"),
            field: "threadId",
          },
          follow: {
            definition: {
              type: "boolean",
              description: "Continue following events",
            },
            target: "control",
          },
          cursor: text("Initial durable stream cursor", "query"),
          offset: text("Initial durable stream offset", "query"),
        },
      }),
    },
  },
  "tool-call": {
    summary: "Tool calls and asynchronous results",
    actions: {
      list: action({
        summary: "List tool calls for a run (client tools show executionType, input, expiresAt)",
        method: "GET",
        path: "/v1/runs/:runId/tool-calls",
        scope: "environment",
        output: "list",
        listField: "toolCalls",
        pagination: runtimePagination,
        args: {
          run: { ...requiredText("Run ID", "path"), field: "runId" },
        },
      }),
      result: action({
        summary: "Submit an asynchronous or client-executed tool result",
        method: "POST",
        path: "/v1/runs/:runId/tool-calls/:toolCallId/results",
        scope: "environment",
        output: "action",
        fileInputs: [
          {
            argument: "output-file",
            bodyField: "output",
            exclusiveWith: "output",
            format: "json",
            required: false,
          },
        ],
        args: {
          id: { ...id, field: "toolCallId" },
          run: { ...requiredText("Run ID", "path"), field: "runId" },
          thread: { ...requiredText("Thread ID"), bodyField: "threadId" },
          "external-operation-id": text(
            "External operation ID (required for provider-asynchronous tools)",
          ),
          outcome: requiredText("completed or failed"),
          output: json("Structured output JSON object (client tools)"),
          "output-file": text("Path to a structured output JSON file", "control"),
          "output-summary": text("Safe output summary"),
        },
      }),
    },
  },
};
