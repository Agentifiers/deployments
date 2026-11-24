export interface ToolAdapterDefinitionCandidate {
  readonly appId?: string | null;
  readonly id?: string;
  readonly organizationId?: string | null;
  readonly toolName: string;
}

export function normalizeToolAdapterScopes(scopes: unknown): string[] {
  let candidate = scopes;
  if (typeof candidate === "string" && candidate.trim().startsWith("[")) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      candidate = [];
    }
  }
  const rawScopes = Array.isArray(candidate) ? candidate : [];
  return [
    ...new Set(
      rawScopes
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

function toolAdapterRank(
  definition: ToolAdapterDefinitionCandidate,
  args: { readonly appId?: string | null; readonly organizationId: string },
) {
  if (definition.organizationId === args.organizationId && definition.appId === args.appId) {
    return 4;
  }
  if (definition.organizationId === args.organizationId && !definition.appId) return 3;
  if (!definition.organizationId && definition.appId === args.appId) return 2;
  if (!definition.organizationId && !definition.appId) return 1;

  return 0;
}

function compareRankedToolAdapterDefinitions<Definition extends ToolAdapterDefinitionCandidate>(
  left: { readonly definition: Definition; readonly rank: number },
  right: { readonly definition: Definition; readonly rank: number },
) {
  const rankDifference = right.rank - left.rank;
  if (rankDifference !== 0) return rankDifference;

  const leftId = left.definition.id?.trim() ?? "";
  const rightId = right.definition.id?.trim() ?? "";
  return leftId.localeCompare(rightId);
}

function rankedToolAdapterDefinitions<Definition extends ToolAdapterDefinitionCandidate>(
  definitions: readonly Definition[],
  args: { readonly appId?: string | null; readonly organizationId: string },
) {
  return definitions
    .map((definition) => ({
      definition,
      rank: toolAdapterRank(definition, args),
    }))
    .filter(({ rank }) => rank > 0)
    .toSorted(compareRankedToolAdapterDefinitions);
}

export function resolveToolAdapterDefinition<Definition extends ToolAdapterDefinitionCandidate>(
  definitions: readonly Definition[],
  args: {
    readonly appId?: string | null;
    readonly organizationId: string;
    readonly toolName: string;
  },
): Definition | undefined {
  return rankedToolAdapterDefinitions(
    definitions.filter((definition) => definition.toolName === args.toolName),
    args,
  ).at(0)?.definition;
}

export function listToolAdapterDefinitionsForApp<Definition extends ToolAdapterDefinitionCandidate>(
  definitions: readonly Definition[],
  args: { readonly appId?: string | null; readonly organizationId: string },
): Definition[] {
  const byToolName = new Map<string, Definition>();
  for (const { definition } of rankedToolAdapterDefinitions(definitions, args)) {
    if (!byToolName.has(definition.toolName)) {
      byToolName.set(definition.toolName, definition);
    }
  }

  return [...byToolName.values()].toSorted((left, right) =>
    left.toolName.localeCompare(right.toolName),
  );
}
