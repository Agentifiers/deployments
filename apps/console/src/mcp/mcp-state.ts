import type {
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
} from "@deployments-ai/api-contract/tooling";
import {
  grantRows,
  type GrantRow,
  type GrantView,
  type PinningDeploymentView,
} from "../connections/connection-state.ts";
import type { RouteResponse } from "../server/platform-api.ts";
import type { ExtensionSummary } from "../server/tool-directory.ts";

export type McpServerView = RouteResponse<"getMcpServer">;
export type McpConnectionView = RouteResponse<"getMcpConnection">;
export type McpDiscovery = RouteResponse<"discoverMcpServer">;
export type DiscoveredTool = McpDiscovery["tools"][number];

export type McpServerSummary = Pick<
  McpServerView,
  "endpointOrigin" | "hasAuth" | "id" | "name" | "status" | "toolAllowlist" | "version"
>;
export type McpConnectionSummary = Pick<
  McpConnectionView,
  "id" | "mcpServerId" | "status" | "version"
>;

export type Parsed<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string };

const ok = <Value>(value: Value): Parsed<Value> => ({ ok: true, value });
const fail = <Value>(message: string): Parsed<Value> => ({ message, ok: false });

export const SERVER_VIEWS = ["active", "all"] as const;
export type ServerView = (typeof SERVER_VIEWS)[number];

export interface ServerSearch {
  readonly show?: "all";
}

export function parseServerSearch(search: Readonly<Record<string, unknown>>): ServerSearch {
  return search.show === "all" ? { show: "all" } : {};
}

export interface ServerRow {
  readonly server: McpServerSummary;
  readonly activeConnections: number;
}

export interface ServerRows {
  readonly complete: boolean;
  readonly rows: readonly ServerRow[];
  readonly hidden: number;
}

export interface McpDirectoryView {
  readonly complete: boolean;
  readonly connections: readonly McpConnectionSummary[];
  readonly servers: readonly McpServerSummary[];
}

const isActive = (resource: { readonly status: string }) => resource.status === "active";

export function serverRows(
  { complete, connections, servers }: McpDirectoryView,
  view: ServerView,
): ServerRows {
  const shown = view === "active" ? servers.filter(isActive) : servers;
  return {
    complete,
    hidden: servers.length - shown.length,
    rows: shown
      .toSorted(
        (left, right) =>
          Number(!isActive(left)) - Number(!isActive(right)) || left.name.localeCompare(right.name),
      )
      .map((server) => ({
        activeConnections: connections.filter(
          (connection) => connection.mcpServerId === server.id && isActive(connection),
        ).length,
        server,
      })),
  };
}

export type ServerAction = "archive" | "connect" | "discover" | "edit";

export function serverActions(server: Pick<McpServerView, "status">): readonly ServerAction[] {
  return isActive(server) ? ["edit", "discover", "connect", "archive"] : [];
}

export function canRevokeConnection(connection: Pick<McpConnectionView, "status">): boolean {
  return connection.status !== "revoked";
}

export type ServerAuth = "deleted" | "none" | "stored";

/** Archiving revokes the stored secret, but the API still reports `hasAuth` for the server. */
export function serverAuth(server: Pick<McpServerView, "hasAuth" | "status">): ServerAuth {
  if (!server.hasAuth) return "none";
  return isActive(server) ? "stored" : "deleted";
}

export function endpointUrl(server: Pick<McpServerView, "endpointOrigin" | "endpointPath">) {
  return `${server.endpointOrigin}${server.endpointPath}`;
}

export interface McpEndpoint {
  readonly origin: string;
  readonly path: string;
}

const ENDPOINT_PATH = /^\/(?!\/)(?!.*(?:^|\/)\.\.?\/)[^#]*$/u;

export function parseEndpoint(text: string): Parsed<McpEndpoint> {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return fail("Enter a full URL, such as https://mcp.example.com/mcp.");
  }
  if (url.protocol !== "https:") return fail("The endpoint must use HTTPS.");
  if (url.username || url.password) {
    return fail("Put credentials under Authentication, not in the URL.");
  }
  if (url.hash) return fail("The endpoint cannot have a # fragment.");
  const path = `${url.pathname}${url.search}`;
  if (!ENDPOINT_PATH.test(path)) return fail("The path cannot start with //.");
  return ok({ origin: url.origin, path });
}

const MAX_NAME_LENGTH = 120;
const MAX_TOOL_NAME_LENGTH = 4_096;

export function parseServerName(text: string): Parsed<string> {
  const name = text.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH
    ? ok(name)
    : fail(`Enter a name of 1 to ${MAX_NAME_LENGTH} characters.`);
}

export function parseToolAllowlist(text: string): Parsed<readonly string[]> {
  const names = [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name !== ""),
    ),
  ];
  if (names.length === 0) {
    return fail("List at least one tool. The platform calls only allowlisted tools.");
  }
  const tooLong = names.find((name) => name.length > MAX_TOOL_NAME_LENGTH);
  return tooLong === undefined
    ? ok(names)
    : fail(`Tool names cannot exceed ${MAX_TOOL_NAME_LENGTH} characters.`);
}

/**
 * `bearerToken` makes the platform send `Authorization: Bearer <token>`; `authorization` is the
 * whole header value, for schemes other than Bearer. The API's `apiToken` is the same as
 * `bearerToken`, so the form does not offer it.
 */
export const MCP_AUTH_FIELDS = ["bearerToken", "authorization"] as const;
export type McpAuthField = (typeof MCP_AUTH_FIELDS)[number];

export type McpAuth =
  | { readonly kind: "none" }
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly field: McpAuthField; readonly value: string };

export type McpAuthOption = "keep" | "none" | McpAuthField;

export interface McpServerDraft {
  readonly auth: McpAuthOption;
  readonly endpoint: string;
  readonly name: string;
  readonly secret: string;
  readonly toolAllowlist: string;
}

export const EMPTY_SERVER_DRAFT: McpServerDraft = {
  auth: "none",
  endpoint: "",
  name: "",
  secret: "",
  toolAllowlist: "",
};

export function serverDraft(server: McpServerView): McpServerDraft {
  return {
    auth: server.hasAuth ? "keep" : "none",
    endpoint: endpointUrl(server),
    name: server.name,
    secret: "",
    toolAllowlist: server.toolAllowlist.join("\n"),
  };
}

/**
 * The platform refuses to point a server's stored secret at a new endpoint
 * (`mcp_auth_replacement_required`), so moving an authenticated server needs new authentication.
 */
export function authReplacementRequired(
  before: Pick<McpServerView, "endpointOrigin" | "endpointPath" | "hasAuth">,
  endpoint: McpEndpoint,
): boolean {
  return (
    before.hasAuth &&
    (endpoint.origin !== before.endpointOrigin || endpoint.path !== before.endpointPath)
  );
}

/** Authentication cannot be removed once stored; it can only be kept or replaced. */
export function authChoices(
  before: Pick<McpServerView, "endpointOrigin" | "endpointPath" | "hasAuth"> | undefined,
  endpoint: McpEndpoint | undefined,
): readonly McpAuthOption[] {
  if (!before?.hasAuth) return ["none", ...MCP_AUTH_FIELDS];
  return endpoint && authReplacementRequired(before, endpoint)
    ? MCP_AUTH_FIELDS
    : ["keep", ...MCP_AUTH_FIELDS];
}

function parseAuth(
  option: McpAuthOption,
  secret: string,
  choices: readonly McpAuthOption[],
): Parsed<McpAuth> {
  if (!choices.includes(option)) {
    return fail(
      option === "keep"
        ? "The endpoint changed, so enter new authentication. The platform does not send the stored secret to a different endpoint."
        : "Stored authentication can be replaced but not removed.",
    );
  }
  if (option === "none" || option === "keep") return ok({ kind: option });
  const value = secret.trim();
  if (value === "") return fail("Enter the secret value.");
  if (/\p{Cc}/u.test(value)) {
    return fail("The secret cannot contain control characters or line breaks.");
  }
  return ok({ field: option, kind: "set", value });
}

export interface McpServerFields {
  readonly auth: McpAuth;
  readonly endpoint: McpEndpoint;
  readonly name: string;
  readonly toolAllowlist: readonly string[];
}

export interface McpServerForm {
  readonly auth: Parsed<McpAuth>;
  readonly authChoices: readonly McpAuthOption[];
  readonly endpoint: Parsed<McpEndpoint>;
  readonly name: Parsed<string>;
  readonly toolAllowlist: Parsed<readonly string[]>;
  /** A hint, not an error: a remote tool name may contain a comma. */
  readonly toolAllowlistHint: string | undefined;
  readonly value: McpServerFields | undefined;
}

/** Editing reads an untouched field as the stored value, so saving leaves it byte-for-byte. */
export function readServerDraft(
  draft: McpServerDraft,
  before?: Pick<McpServerView, "endpointOrigin" | "endpointPath" | "hasAuth" | "toolAllowlist">,
): McpServerForm {
  const name = parseServerName(draft.name);
  const endpoint =
    before && draft.endpoint === endpointUrl(before)
      ? ok({ origin: before.endpointOrigin, path: before.endpointPath })
      : parseEndpoint(draft.endpoint);
  const toolAllowlist =
    before && draft.toolAllowlist === before.toolAllowlist.join("\n")
      ? ok(before.toolAllowlist)
      : parseToolAllowlist(draft.toolAllowlist);
  const choices = authChoices(before, endpoint.ok ? endpoint.value : undefined);
  const auth = parseAuth(draft.auth, draft.secret, choices);
  return {
    auth,
    authChoices: choices,
    endpoint,
    name,
    toolAllowlist,
    toolAllowlistHint:
      toolAllowlist.ok &&
      toolAllowlist.value.some(
        (tool) => tool.includes(",") && !before?.toolAllowlist.includes(tool),
      )
        ? "Put each tool on its own line."
        : undefined,
    value:
      name.ok && endpoint.ok && toolAllowlist.ok && auth.ok
        ? {
            auth: auth.value,
            endpoint: endpoint.value,
            name: name.value,
            toolAllowlist: toolAllowlist.value,
          }
        : undefined,
  };
}

function authBody(auth: McpAuth) {
  return auth.kind === "set" ? { auth: { [auth.field]: auth.value } } : {};
}

export function createServerBody(fields: McpServerFields): typeof CreateMcpServerRequest.Encoded {
  return {
    ...authBody(fields.auth),
    endpointOrigin: fields.endpoint.origin,
    endpointPath: fields.endpoint.path,
    name: fields.name,
    toolAllowlist: fields.toolAllowlist,
  };
}

export type McpServerChanges = Omit<typeof UpdateMcpServerRequest.Encoded, "expectedVersion">;

export function serverChanges(
  before: Pick<McpServerView, "endpointOrigin" | "endpointPath" | "name" | "toolAllowlist">,
  fields: McpServerFields,
): McpServerChanges {
  const sameAllowlist =
    fields.toolAllowlist.length === before.toolAllowlist.length &&
    fields.toolAllowlist.every((name) => before.toolAllowlist.includes(name));
  return {
    ...authBody(fields.auth),
    ...(fields.endpoint.origin === before.endpointOrigin
      ? {}
      : { endpointOrigin: fields.endpoint.origin }),
    ...(fields.endpoint.path === before.endpointPath ? {} : { endpointPath: fields.endpoint.path }),
    ...(fields.name === before.name ? {} : { name: fields.name }),
    ...(sameAllowlist ? {} : { toolAllowlist: fields.toolAllowlist }),
  };
}

export interface DiscoveryRow {
  readonly remoteName: string;
  readonly tool: DiscoveredTool | undefined;
}

export function discoveryRows(
  allowlist: readonly string[],
  discovery: Pick<McpDiscovery, "tools">,
): readonly DiscoveryRow[] {
  const found = new Map(discovery.tools.map((tool) => [tool.remoteName, tool]));
  return allowlist.map((remoteName) => ({ remoteName, tool: found.get(remoteName) }));
}

/**
 * Scopes a grant on one of the server's connections may carry: the required scopes of the
 * server's active extension tools, as the API computes them when it creates the grant.
 */
export function mcpGrantableScopes(
  serverId: string,
  extensions: readonly Pick<ExtensionSummary, "execution" | "requiredScopes" | "status">[],
): readonly string[] {
  return [
    ...new Set(
      extensions
        .filter(
          (extension) =>
            extension.status === "active" &&
            extension.execution.type === "mcp" &&
            extension.execution.mcpServerId === serverId,
        )
        .flatMap((extension) => extension.requiredScopes),
    ),
  ].toSorted();
}

export interface ConnectionUsage {
  readonly connection: McpConnectionSummary;
  readonly grants: readonly GrantRow[];
}

export interface Capped<Item> {
  readonly complete: boolean;
  readonly items: readonly Item[];
}

export interface GrantReads {
  readonly deployments: Capped<PinningDeploymentView>;
  readonly grants: Capped<GrantView>;
}

export type GrantCoverage = "complete" | "partial" | "unread";

export interface ServerUsage {
  /** False when the directory of MCP servers and connections was capped. */
  readonly complete: boolean;
  readonly connections: readonly ConnectionUsage[];
  readonly grantCoverage: GrantCoverage;
}

export function serverUsage(
  serverId: string,
  directory: Pick<McpDirectoryView, "complete" | "connections">,
  reads: GrantReads | undefined,
): ServerUsage {
  return {
    complete: directory.complete,
    connections: directory.connections
      .filter((connection) => connection.mcpServerId === serverId)
      .toSorted(
        (left, right) =>
          Number(!canRevokeConnection(left)) - Number(!canRevokeConnection(right)) ||
          right.id.localeCompare(left.id),
      )
      .map((connection) => ({
        connection,
        grants: reads ? grantRows(connection.id, reads.grants.items, reads.deployments.items) : [],
      })),
    grantCoverage:
      reads === undefined
        ? "unread"
        : reads.grants.complete && reads.deployments.complete
          ? "complete"
          : "partial",
  };
}

export type Pinning =
  | { readonly checked: false }
  | {
      readonly checked: true;
      readonly complete: boolean;
      readonly deploymentIds: readonly string[];
    };

/**
 * Archiving a server or revoking a connection cascades to nothing, so the runtime denies these
 * deployments' tools. One listed connection's pins do not depend on the capped connection list.
 */
export function pinning(usage: ServerUsage, connectionId?: string): Pinning {
  if (usage.grantCoverage === "unread") return { checked: false };
  const connections =
    connectionId === undefined
      ? usage.connections
      : usage.connections.filter(({ connection }) => connection.id === connectionId);
  return {
    checked: true,
    complete: usage.grantCoverage === "complete" && (connectionId !== undefined || usage.complete),
    deploymentIds: [
      ...new Set(
        connections.flatMap(({ grants }) =>
          grants
            .filter((row) => row.grant.status === "active")
            .flatMap((row) => row.uses.map((use) => use.deploymentId)),
        ),
      ),
    ].toSorted(),
  };
}
