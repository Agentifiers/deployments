import { TOOL_CATALOG_STATUS_FILTERS } from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import {
  canonicalScopes,
  findPlatformToolAdapterDefinition,
  platformToolAdapterDefinitions,
  toolExecutionRoute,
  toolPolicyBinding,
  type ToolAdapterDefinition,
} from "@deployments-ai/tools";
import { invalidQuery } from "./catalog-query-validation.ts";

export interface ToolListFilters {
  readonly prefix?: string;
  readonly providerKey?: string;
  readonly search?: string;
  readonly status: (typeof TOOL_CATALOG_STATUS_FILTERS)[number];
}

const MAX_FILTER_LENGTH = 128;
const MAX_SEARCH_LENGTH = 100;
const MAX_TOOL_NAME_LENGTH = 128;

function textFilter(searchParams: URLSearchParams, name: string, maximum: number) {
  const value = searchParams.get(name);
  if (value === null) return undefined;
  if (value.length === 0 || value.length > maximum) {
    throw invalidQuery(name, `1 through ${maximum} characters`);
  }
  return value;
}

/** Parses the listTools filters; unknown or out-of-range values are client errors. */
export function parseToolListFilters(searchParams: URLSearchParams): ToolListFilters {
  const rawStatus = searchParams.get("status");
  const status =
    rawStatus === null
      ? "active"
      : TOOL_CATALOG_STATUS_FILTERS.find((candidate) => candidate === rawStatus);
  if (!status) throw invalidQuery("status", `one of ${TOOL_CATALOG_STATUS_FILTERS.join(", ")}`);
  const providerKey = textFilter(searchParams, "providerKey", MAX_FILTER_LENGTH);
  const prefix = textFilter(searchParams, "prefix", MAX_FILTER_LENGTH);
  const search = textFilter(searchParams, "search", MAX_SEARCH_LENGTH);
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(providerKey === undefined ? {} : { providerKey }),
    ...(search === undefined ? {} : { search }),
    status,
  };
}

function cursorToolName(cursor: string) {
  const toolName = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    toolName.length === 0 ||
    toolName.length > MAX_TOOL_NAME_LENGTH ||
    Buffer.from(toolName, "utf8").toString("base64url") !== cursor
  ) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
  return toolName;
}

/** The public projection of a code-owned definition; the dispatcher decodes it. */
function catalogItem(definition: ToolAdapterDefinition) {
  const provider = definition.provider
    ? codeProviderDefinitionRegistry().resolve(definition.provider)
    : undefined;
  const unregistered = definition.provider !== undefined && provider === undefined;
  const executionRoute = toolExecutionRoute(definition);
  return {
    approvalRequired: definition.defaultPolicyAction === "require_approval",
    category: provider?.category ?? (unregistered ? "unregistered" : "platform"),
    defaultPolicyAction: definition.defaultPolicyAction,
    description: definition.description,
    effect: definition.effect,
    name: definition.toolName,
    policyBinding: executionRoute ? toolPolicyBinding(executionRoute) : null,
    ...(definition.provider ? { providerKey: definition.provider } : {}),
    requiredScopes: canonicalScopes(definition.requiredScopes),
    route: provider?.route ?? (unregistered ? "unregistered" : "builtin"),
    status: definition.status === "active" ? ("active" as const) : ("archived" as const),
  };
}

function matchesFilters(definition: ToolAdapterDefinition, filters: ToolListFilters) {
  const status = definition.status === "active" ? "active" : "archived";
  if (filters.status !== "all" && status !== filters.status) return false;
  if (filters.prefix !== undefined && !definition.toolName.startsWith(filters.prefix)) return false;
  if (filters.providerKey !== undefined) {
    const wanted =
      codeProviderDefinitionRegistry().resolve(filters.providerKey)?.key ?? filters.providerKey;
    if (definition.provider !== wanted) return false;
  }
  if (filters.search !== undefined) {
    const search = filters.search.toLowerCase();
    return (
      definition.toolName.toLowerCase().includes(search) ||
      definition.description.toLowerCase().includes(search)
    );
  }
  return true;
}

/**
 * One page of the code-owned platform tool catalog ordered by tool name; the cursor is the last
 * returned tool name. Tenant extension and synced vendor MCP tools are listed by `/v1/extensions`.
 */
export function toolCatalogPage(input: {
  readonly cursor?: string;
  readonly filters: ToolListFilters;
  readonly limit: number;
}) {
  const after = input.cursor === undefined ? undefined : cursorToolName(input.cursor);
  const definitions = platformToolAdapterDefinitions
    .filter(
      (definition) =>
        (after === undefined || definition.toolName > after) &&
        matchesFilters(definition, input.filters),
    )
    .toSorted((left, right) =>
      left.toolName < right.toolName ? -1 : left.toolName > right.toolName ? 1 : 0,
    );
  const page = definitions.slice(0, input.limit);
  return {
    items: page.map(catalogItem),
    nextCursor:
      definitions.length > input.limit
        ? Buffer.from(page.at(-1)!.toolName, "utf8").toString("base64url")
        : null,
  };
}

/** A code-owned definition with its input and output schemas, including archived tools. */
export function toolCatalogDetail(toolName: string) {
  const definition = findPlatformToolAdapterDefinition(toolName);
  if (!definition) {
    throw new PersistenceError("not-found", "resource_not_found", "Tool was not found.");
  }
  const inputSchema =
    definition.inputSchema &&
    typeof definition.inputSchema === "object" &&
    !Array.isArray(definition.inputSchema)
      ? (definition.inputSchema as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    ...catalogItem(definition),
    ...(inputSchema ? { inputSchema } : {}),
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
  };
}
