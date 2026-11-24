import type { VendorMcpToolSyncChange } from "@deployments-ai/api-contract/providers";
import { oneOf } from "../observability/range.ts";
import type { PlatformProblem } from "../errors.ts";
import type {
  ExtensionDirectory,
  ExtensionSummary,
  McpDirectory,
} from "../server/tool-directory.ts";
import {
  EXECUTION_TYPES,
  type Action,
  type ExecutionType,
  type NewDraftPrefill,
} from "./extension-draft.ts";

export const EXTENSION_VIEWS = ["active", "all"] as const;
export type ExtensionView = (typeof EXTENSION_VIEWS)[number];
export const EXTENSION_KINDS = [...EXECUTION_TYPES, "vendor_mcp"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const KIND_LABELS: Readonly<Record<ExtensionKind, string>> = {
  client: "Client-executed",
  hosted_code: "Hosted code",
  http_callback: "HTTP callback",
  mcp: "MCP",
  vendor_mcp: "Vendor MCP",
};

export interface ExtensionSearch {
  readonly show?: "all";
  readonly type?: ExtensionKind;
}

export interface ExtensionPage {
  /** Present when the environment has more extensions than the console reads: how many it read. */
  readonly cappedAt?: number;
  readonly extensions: readonly ExtensionSummary[];
  readonly hidden: number;
  readonly nextOffset?: number;
}

export function parseExtensionSearch(search: Readonly<Record<string, unknown>>): ExtensionSearch {
  const type = oneOf(EXTENSION_KINDS, search.type);
  return { ...(search.show === "all" ? { show: "all" } : {}), ...(type ? { type } : {}) };
}

/** Active extensions first, by name; the active view hides archived ones and counts them. */
export function extensionPage(
  { complete, extensions }: ExtensionDirectory,
  {
    offset,
    pageSize,
    search,
  }: { readonly offset: number; readonly pageSize: number; readonly search: ExtensionSearch },
): ExtensionPage {
  const ofKind = extensions.filter(
    (extension) => search.type === undefined || extension.execution.type === search.type,
  );
  const archived = (extension: ExtensionSummary) => Number(extension.status !== "active");
  const shown = (
    search.show === "all" ? ofKind : ofKind.filter((extension) => archived(extension) === 0)
  ).toSorted(
    (left, right) => archived(left) - archived(right) || left.name.localeCompare(right.name),
  );
  const end = offset + pageSize;
  return {
    ...(complete ? {} : { cappedAt: extensions.length }),
    extensions: shown.slice(offset, end),
    hidden: ofKind.length - shown.length,
    ...(end < shown.length ? { nextOffset: end } : {}),
  };
}

export interface NewExtensionSearch extends NewDraftPrefill {
  readonly type?: ExecutionType;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** `?type=mcp&server=&remote=` arrives from a discovered MCP tool. */
export function parseNewExtensionSearch(
  search: Readonly<Record<string, unknown>>,
): NewExtensionSearch {
  const type = oneOf(EXECUTION_TYPES, search.type);
  const { remote, server } = search;
  return {
    ...(type ? { type } : {}),
    ...(typeof server === "string" && ULID.test(server) ? { server } : {}),
    ...(typeof remote === "string" && remote.length > 0 && remote.length <= 4_096
      ? { remote }
      : {}),
  };
}

const TOOL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?$/u;

/**
 * The API reads an extension only by name, so a link to one the capped directory may miss carries
 * `?name=` beside its ID.
 */
export interface ExtensionLocator {
  readonly extensionId: string;
  readonly name?: string;
}

export function parseExtensionLocator(
  search: Readonly<Record<string, unknown>>,
): Omit<ExtensionLocator, "extensionId"> {
  const { name } = search;
  return typeof name === "string" && TOOL_NAME.test(name) ? { name } : {};
}

export interface McpServerOption {
  readonly id: string;
  readonly name: string;
  readonly toolAllowlist: readonly string[];
}

export interface McpServerOptions {
  /** The server read or the connection read stopped at its cap. */
  readonly capped: boolean;
  readonly servers: readonly McpServerOption[];
}

export function mcpServerOptions({ complete, servers }: McpDirectory): McpServerOptions {
  return {
    capped: !complete,
    servers: servers
      .filter((server) => server.status === "active")
      .map(({ id, name, toolAllowlist }) => ({ id, name, toolAllowlist })),
  };
}

export function serverChoices(
  listed: readonly McpServerOption[],
  beyond: McpServerOption | undefined,
): readonly McpServerOption[] {
  return beyond === undefined || listed.some(({ id }) => id === beyond.id)
    ? listed
    : [...listed, beyond];
}

/** Problem copy advises granting an unverified connection; sync needs verifying it instead. */
export function syncProblem(problem: PlatformProblem): PlatformProblem {
  if (problem.code !== "connection_not_verified") return problem;
  const { code: _code, ...rest } = problem;
  return {
    ...rest,
    detail: `${problem.detail ?? problem.title} Verify the connection, then sync again.`,
    title: "Connection not verified",
  };
}

type SyncChange = typeof VendorMcpToolSyncChange.Type;

/** Sync's rule for a vendor tool's default: only a classified read runs without approval. */
export function syncDefaultAction({
  classified,
  effect,
}: Pick<SyncChange, "classified" | "effect">): Action {
  return classified && effect === "read" ? "allow" : "require_approval";
}

const SYNC_ORDER = [
  "rejected",
  "created",
  "updated",
  "archived",
  "unchanged",
] as const satisfies readonly SyncChange["change"][];

export interface SyncGroup {
  readonly change: SyncChange["change"];
  readonly tools: readonly SyncChange[];
}

/** Rejections first, because each one is a remote tool agents cannot call. */
export function syncGroups(tools: readonly SyncChange[]): readonly SyncGroup[] {
  return SYNC_ORDER.map((change) => ({
    change,
    tools: tools.filter((tool) => tool.change === change),
  })).filter((group) => group.tools.length > 0);
}

export const REJECTION_REASONS: Readonly<Record<string, string>> = {
  description_too_large: "Its description is larger than 8 KiB.",
  input_schema_not_object: "Its input schema does not declare type: object.",
  input_schema_too_large: "Its input schema is larger than 64 KiB.",
  input_schema_unrepresentable: "Its input schema holds values the platform cannot store.",
  invalid_name: "Its name cannot become a tool name.",
  name_collision: "Another extension in this environment already uses its tool name.",
  name_reserved: "A built-in catalog tool already uses its tool name.",
  record_unrepresentable: "The platform could not store it.",
};
