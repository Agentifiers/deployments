import {
  AGENT_TOOL_NAME_PATTERN_SOURCE,
  AgentToolName,
} from "@deployments-ai/agent-manifest/schema";
import { Schema } from "effect";
import {
  HOSTED_CODE_CONTENT_HASH_PATTERN_SOURCE,
  HOSTED_CODE_TOOL_API_SCHEMAS,
  HostedCodeSecrets,
  HostedCodeToolExecution,
  HostedCodeToolExecutionView,
} from "./hosted-code-tools.ts";
import { JsonValue, PublicId, ResourceName, ScopeList, Timestamp } from "./primitives.ts";
import { ProviderKey } from "./providers.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

const Version = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const Action = Schema.Literals(["allow", "deny", "require_approval"]);
const Effect = Schema.Literals(["execute", "read", "write"]);
const NonEmptyText = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(4_096)),
);
const InputSchema = Schema.Record(Schema.String, JsonValue).pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, typeof JsonValue.Type>>>((value) =>
      value.type === "object" ? undefined : "Tool input schemas must declare type: object.",
    ),
  ),
);
const ToolPolicyRule = Schema.Struct({
  action: Action,
  connectorProvider: Schema.optional(ProviderKey),
  effect: Schema.optional(Schema.Union([Effect, Schema.Array(Effect)])),
  providerKey: Schema.optional(ProviderKey),
  reason: Schema.optional(NonEmptyText),
  requiredScopes: Schema.optional(Schema.Array(NonEmptyText)),
  toolName: Schema.optional(AgentToolName),
  toolPrefix: Schema.optional(NonEmptyText),
});
export const ToolPolicyDocument = Schema.Struct({
  defaultAction: Schema.optional(Action),
  defaultReason: Schema.optional(NonEmptyText),
  rules: Schema.Array(ToolPolicyRule),
});
export const CreateToolPolicyRequest = Schema.Struct({
  description: Schema.optional(Schema.String),
  name: ResourceName,
  policy: ToolPolicyDocument,
});
export const UpdateToolPolicyRequest = Schema.Struct({
  description: Schema.optional(Schema.String),
  expectedVersion: Version,
  name: Schema.optional(ResourceName),
  policy: Schema.optional(ToolPolicyDocument),
});
export const ToolPolicyResponse = Schema.Struct({
  createdAt: Timestamp,
  description: Schema.optional(Schema.String),
  id: PublicId,
  name: ResourceName,
  policy: ToolPolicyDocument,
  status: Schema.String,
  updatedAt: Timestamp,
  version: Version,
});

const HttpsOrigin = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" &&
          url.origin === value &&
          !url.username &&
          !url.password &&
          url.pathname === "/"
          ? undefined
          : "MCP endpointOrigin must be an HTTPS origin.";
      } catch {
        return "MCP endpointOrigin must be a valid HTTPS origin.";
      }
    }),
  ),
);
const EndpointPath = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\/(?!\/)(?!.*(?:^|\/)\.\.?\/)[^#]*$/u)),
);
const SecretDocument = Schema.Record(Schema.String, Schema.String);
export const CreateMcpServerRequest = Schema.Struct({
  auth: Schema.optional(SecretDocument),
  endpointOrigin: HttpsOrigin,
  endpointPath: EndpointPath,
  name: ResourceName,
  toolAllowlist: Schema.Array(NonEmptyText),
});
export const UpdateMcpServerRequest = Schema.Struct({
  auth: Schema.optional(SecretDocument),
  endpointOrigin: Schema.optional(HttpsOrigin),
  endpointPath: Schema.optional(EndpointPath),
  expectedVersion: Version,
  name: Schema.optional(ResourceName),
  toolAllowlist: Schema.optional(Schema.Array(NonEmptyText)),
});
export const McpServerResponse = Schema.Struct({
  createdAt: Timestamp,
  endpointOrigin: HttpsOrigin,
  endpointPath: EndpointPath,
  hasAuth: Schema.Boolean,
  id: PublicId,
  name: ResourceName,
  status: Schema.String,
  toolAllowlist: Schema.Array(Schema.String),
  updatedAt: Timestamp,
  version: Version,
});
export const CreateMcpConnectionRequest = Schema.Struct({
  mcpServerId: PublicId,
});
export const McpConnectionResponse = Schema.Struct({
  createdAt: Timestamp,
  id: PublicId,
  mcpServerId: PublicId,
  status: Schema.String,
  updatedAt: Timestamp,
  version: Version,
});

export const McpToolExecution = Schema.Struct({
  mcpServerId: PublicId,
  remoteToolName: NonEmptyText,
  type: Schema.Literal("mcp"),
});
/**
 * Read-only view of a tool synced from a vendor-hosted MCP server through
 * `POST /v1/connections/:connectionId/tools/sync`; extensions cannot be created with it.
 */
export const VendorMcpToolExecution = Schema.Struct({
  providerKey: ProviderKey,
  remoteToolName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  toolHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))),
  type: Schema.Literal("vendor_mcp"),
});
/** Vendor MCP tool descriptions may be up to 8 KiB. */
const ExtensionToolDescriptionView = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(8_192)),
);
export const CALLBACK_WORKSPACE_FILES_MAX_PATTERNS = 16;
export const CALLBACK_WORKSPACE_FILES_MAX_PATTERN_LENGTH = 256;
/** One Python `glob` pattern (`recursive=True`) relative to the thread sandbox's `/workspace`. */
export const CallbackWorkspaceFilePattern = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      if (value.length === 0) return "Workspace file patterns must not be empty.";
      if (value.length > CALLBACK_WORKSPACE_FILES_MAX_PATTERN_LENGTH) {
        return `Workspace file patterns must be at most ${CALLBACK_WORKSPACE_FILES_MAX_PATTERN_LENGTH} characters.`;
      }
      if (value.includes("\0")) return "Workspace file patterns must not contain NUL.";
      if (value.startsWith("/")) return "Workspace file patterns must be relative to /workspace.";
      if (value.split("/").includes("..")) {
        return "Workspace file patterns must not contain '..' segments.";
      }
      return undefined;
    }),
  ),
);
/** Thread-sandbox files attached to every dispatch of an HTTP callback tool. */
export const CallbackWorkspaceFiles = Schema.Struct({
  include: Schema.Array(CallbackWorkspaceFilePattern).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(CALLBACK_WORKSPACE_FILES_MAX_PATTERNS)),
  ),
});
/**
 * Run facts an HTTP callback tool receives on every dispatch. `origin` adds the channel binding
 * and chat sender to calls from runs that channel ingress started.
 */
export const CallbackRunContext = Schema.Array(Schema.Literal("origin")).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isUnique()),
);
export const CallbackToolExecution = Schema.Struct({
  completionMode: Schema.optional(Schema.Literal("sync")),
  endpointOrigin: HttpsOrigin,
  endpointPath: EndpointPath,
  runContext: Schema.optional(CallbackRunContext),
  type: Schema.Literal("http_callback"),
  workspaceFiles: Schema.optional(CallbackWorkspaceFiles),
});
export const CLIENT_TOOL_DEFAULT_TIMEOUT_MS = 900_000;
export const CLIENT_TOOL_MAX_TIMEOUT_MS = 3_600_000;
export const ClientToolExecution = Schema.Struct({
  timeoutMs: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1_000),
        Schema.isLessThanOrEqualTo(CLIENT_TOOL_MAX_TIMEOUT_MS),
      ),
    ),
  ),
  type: Schema.Literal("client"),
});
export const ExtensionToolExecution = Schema.Union([
  McpToolExecution,
  CallbackToolExecution,
  ClientToolExecution,
  HostedCodeToolExecution,
]);
const ExtensionToolExecutionView = Schema.Union([
  McpToolExecution,
  CallbackToolExecution,
  ClientToolExecution,
  HostedCodeToolExecutionView,
  VendorMcpToolExecution,
]);
const CreateExtensionToolFields = {
  defaultPolicyAction: Action,
  description: NonEmptyText,
  inputSchema: InputSchema,
  name: AgentToolName,
  requiredScopes: ScopeList,
} as const;
export const CreateExtensionToolRequest = Schema.Union([
  Schema.Struct({
    ...CreateExtensionToolFields,
    effect: Schema.Literal("read"),
    execution: McpToolExecution,
  }),
  Schema.Struct({
    ...CreateExtensionToolFields,
    callbackSecret: NonEmptyText,
    effect: Effect,
    execution: CallbackToolExecution,
    providerKey: ProviderKey,
  }),
  Schema.Struct({
    ...CreateExtensionToolFields,
    effect: Effect,
    execution: ClientToolExecution,
    outputSchema: Schema.optional(InputSchema),
  }),
  Schema.Struct({
    ...CreateExtensionToolFields,
    effect: Effect,
    execution: HostedCodeToolExecution,
    outputSchema: InputSchema,
    secrets: Schema.optional(HostedCodeSecrets),
  }),
]);
export const UpdateExtensionToolRequest = Schema.Struct({
  callbackSecret: Schema.optional(NonEmptyText),
  defaultPolicyAction: Schema.optional(Action),
  description: Schema.optional(NonEmptyText),
  effect: Schema.optional(Effect),
  execution: Schema.optional(ExtensionToolExecution),
  expectedVersion: Version,
  inputSchema: Schema.optional(InputSchema),
  outputSchema: Schema.optional(InputSchema),
  providerKey: Schema.optional(ProviderKey),
  requiredScopes: Schema.optional(ScopeList),
  secrets: Schema.optional(HostedCodeSecrets),
});
export const ExtensionToolResponse = Schema.Struct({
  createdAt: Timestamp,
  defaultPolicyAction: Action,
  description: ExtensionToolDescriptionView,
  effect: Effect,
  execution: ExtensionToolExecutionView,
  id: PublicId,
  hasCallbackAuth: Schema.Boolean,
  inputSchema: InputSchema,
  outputSchema: Schema.optional(InputSchema),
  name: AgentToolName,
  providerKey: Schema.optional(ProviderKey),
  requiredScopes: Schema.Array(Schema.String),
  status: Schema.String,
  updatedAt: Timestamp,
  version: Version,
});
export const ListToolPoliciesResponse = Schema.Struct({
  items: Schema.Array(ToolPolicyResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ListMcpServersResponse = Schema.Struct({
  items: Schema.Array(McpServerResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ListMcpConnectionsResponse = Schema.Struct({
  items: Schema.Array(McpConnectionResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const ListExtensionToolsResponse = Schema.Struct({
  items: Schema.Array(ExtensionToolResponse),
  nextCursor: Schema.NullOr(Schema.String),
});
export const McpDiscoveryResponse = Schema.Struct({
  serverId: PublicId,
  tools: Schema.Array(
    Schema.Struct({
      description: Schema.optional(Schema.String),
      inputSchema: InputSchema,
      remoteName: NonEmptyText,
    }),
  ),
  verifiedAt: Timestamp,
});

export const TOOLING_API_SCHEMAS = {
  CallbackToolExecution,
  CreateExtensionToolRequest,
  CreateMcpConnectionRequest,
  CreateMcpServerRequest,
  CreateToolPolicyRequest,
  ExtensionToolResponse,
  ListExtensionToolsResponse,
  ListMcpConnectionsResponse,
  ListMcpServersResponse,
  ListToolPoliciesResponse,
  McpConnectionResponse,
  McpDiscoveryResponse,
  McpServerResponse,
  McpToolExecution,
  ToolPolicyDocument,
  ToolPolicyResponse,
  UpdateExtensionToolRequest,
  UpdateMcpServerRequest,
  UpdateToolPolicyRequest,
  VendorMcpToolExecution,
  ...HOSTED_CODE_TOOL_API_SCHEMAS,
} as const;

type Input = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "scopeHeaders" | "tag"
> & { readonly tag?: "Extensions" | "Tools" };
const readErrors = [400, 401, 403, 404, 422] as const;
const mutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
const listQueryParameters = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const;
function toolingRoute<const Route extends Input>(route: Route) {
  const mutation = route.method !== "GET";
  return {
    authentication: "platform-bearer" as const,
    errors: mutation ? mutationErrors : readErrors,
    idempotency: mutation ? ("required" as const) : ("none" as const),
    scopeHeaders: "environment" as const,
    tag: route.tag ?? ("Tools" as const),
    ...route,
    ...(route.name.startsWith("list") ? { queryParameters: listQueryParameters } : {}),
  };
}

export const TOOLING_API_ROUTES = [
  toolingRoute({
    method: "GET",
    name: "listToolPolicies",
    path: "/v1/tool-policies",
    responseBody: "ListToolPoliciesResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "createToolPolicy",
    path: "/v1/tool-policies",
    requestBody: "CreateToolPolicyRequest",
    responseBody: "ToolPolicyResponse",
    successStatus: 201,
  }),
  toolingRoute({
    method: "GET",
    name: "getToolPolicy",
    path: "/v1/tool-policies/:id",
    responseBody: "ToolPolicyResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "PATCH",
    name: "updateToolPolicy",
    path: "/v1/tool-policies/:id",
    requestBody: "UpdateToolPolicyRequest",
    responseBody: "ToolPolicyResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "DELETE",
    name: "archiveToolPolicy",
    path: "/v1/tool-policies/:id",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ToolPolicyResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "GET",
    name: "listMcpServers",
    path: "/v1/mcp-servers",
    tag: "Extensions",
    responseBody: "ListMcpServersResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "createMcpServer",
    path: "/v1/mcp-servers",
    tag: "Extensions",
    requestBody: "CreateMcpServerRequest",
    responseBody: "McpServerResponse",
    successStatus: 201,
  }),
  toolingRoute({
    method: "GET",
    name: "getMcpServer",
    path: "/v1/mcp-servers/:id",
    tag: "Extensions",
    responseBody: "McpServerResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "PATCH",
    name: "updateMcpServer",
    path: "/v1/mcp-servers/:id",
    tag: "Extensions",
    requestBody: "UpdateMcpServerRequest",
    responseBody: "McpServerResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "discoverMcpServer",
    path: "/v1/mcp-servers/:id/discover",
    tag: "Extensions",
    responseBody: "McpDiscoveryResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "DELETE",
    name: "archiveMcpServer",
    path: "/v1/mcp-servers/:id",
    tag: "Extensions",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "McpServerResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "GET",
    name: "listMcpConnections",
    path: "/v1/mcp-connections",
    tag: "Extensions",
    responseBody: "ListMcpConnectionsResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "createMcpConnection",
    path: "/v1/mcp-connections",
    tag: "Extensions",
    requestBody: "CreateMcpConnectionRequest",
    responseBody: "McpConnectionResponse",
    successStatus: 201,
  }),
  toolingRoute({
    method: "GET",
    name: "getMcpConnection",
    path: "/v1/mcp-connections/:id",
    tag: "Extensions",
    responseBody: "McpConnectionResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "DELETE",
    name: "revokeMcpConnection",
    path: "/v1/mcp-connections/:id",
    tag: "Extensions",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "McpConnectionResponse",
    standing: "remediation",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "createHostedCodeArtifact",
    path: "/v1/hosted-code-artifacts",
    tag: "Extensions",
    requestBody: "CreateHostedCodeArtifactRequest",
    responseBody: "HostedCodeArtifactResponse",
    successStatus: 201,
  }),
  toolingRoute({
    method: "GET",
    name: "getHostedCodeArtifact",
    path: "/v1/hosted-code-artifacts/:contentHash",
    pathParameters: [
      {
        name: "contentHash",
        schema: { pattern: HOSTED_CODE_CONTENT_HASH_PATTERN_SOURCE, type: "string" },
      },
    ],
    tag: "Extensions",
    responseBody: "HostedCodeArtifactResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "GET",
    name: "listExtensionTools",
    path: "/v1/extensions",
    tag: "Extensions",
    responseBody: "ListExtensionToolsResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "POST",
    name: "createExtensionTool",
    path: "/v1/extensions",
    tag: "Extensions",
    requestBody: "CreateExtensionToolRequest",
    responseBody: "ExtensionToolResponse",
    successStatus: 201,
  }),
  toolingRoute({
    method: "GET",
    name: "getExtensionTool",
    path: "/v1/extensions/:toolName",
    pathParameters: [
      { name: "toolName", schema: { pattern: AGENT_TOOL_NAME_PATTERN_SOURCE, type: "string" } },
    ],
    tag: "Extensions",
    responseBody: "ExtensionToolResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "PATCH",
    name: "updateExtensionTool",
    path: "/v1/extensions/:toolName",
    pathParameters: [
      { name: "toolName", schema: { pattern: AGENT_TOOL_NAME_PATTERN_SOURCE, type: "string" } },
    ],
    tag: "Extensions",
    requestBody: "UpdateExtensionToolRequest",
    responseBody: "ExtensionToolResponse",
    successStatus: 200,
  }),
  toolingRoute({
    method: "DELETE",
    name: "archiveExtensionTool",
    path: "/v1/extensions/:toolName",
    pathParameters: [
      { name: "toolName", schema: { pattern: AGENT_TOOL_NAME_PATTERN_SOURCE, type: "string" } },
    ],
    tag: "Extensions",
    requestBody: "RevokeAdministrationResourceRequest",
    requestBodyRequired: false,
    responseBody: "ExtensionToolResponse",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type ToolingApiRouteName = (typeof TOOLING_API_ROUTES)[number]["name"];
