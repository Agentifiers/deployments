import type {
  ProviderDefinitionInput,
  ProviderDefinition,
  ProviderDefinitionRegistry,
} from "./provider-definition-types.ts";

import { freezeDeepArray } from "./provider-key-schema-normalization.ts";
import { normalizeProviderDefinition } from "./provider-definition-normalization.ts";

export function createProviderDefinitionRegistry(
  inputs: readonly ProviderDefinitionInput[],
): ProviderDefinitionRegistry {
  if (!Array.isArray(inputs)) {
    throw new Error("Provider definitions must be an array.");
  }

  const definitions: ProviderDefinition[] = [];
  const byKey = new Map<string, ProviderDefinition>();
  const byAlias = new Map<string, ProviderDefinition>();
  const byOAuthProviderKeyMutable = new Map<string, ProviderDefinition[]>();
  /** Exclusive claims for canonical keys and aliases only. */
  const claimedIdentifiers = new Map<string, string>();

  const claimExclusive = (identifier: string, canonicalKey: string, kind: "key" | "alias") => {
    const existing = claimedIdentifiers.get(identifier);
    if (existing !== undefined) {
      // Allow a provider's own key to also appear as its alias claim target only
      // when both resolve to the same canonical key (key claim is always exclusive).
      if (kind !== "key" && existing === canonicalKey) {
        return;
      }
      throw new Error(
        `Duplicate provider ${kind} "${identifier}" conflicts with provider "${existing}".`,
      );
    }
    claimedIdentifiers.set(identifier, canonicalKey);
  };

  for (const input of inputs) {
    const definition = normalizeProviderDefinition(input);

    claimExclusive(definition.key, definition.key, "key");
    byKey.set(definition.key, definition);

    for (const alias of definition.aliases) {
      claimExclusive(alias, definition.key, "alias");
      byAlias.set(alias, definition);
    }

    if (definition.oauthProviderKey) {
      const existing = byOAuthProviderKeyMutable.get(definition.oauthProviderKey) ?? [];
      existing.push(definition);
      byOAuthProviderKeyMutable.set(definition.oauthProviderKey, existing);
    }

    definitions.push(definition);
  }

  // Freeze per-app lists in canonical-key order for deterministic expansion.
  const byOAuthProviderKey = new Map<string, readonly ProviderDefinition[]>();
  for (const [slug, group] of byOAuthProviderKeyMutable) {
    if (
      group.some((definition) => definition.route === "vendor_mcp") &&
      group.some((definition) => definition.route !== "vendor_mcp")
    ) {
      throw new Error(
        `OAuth provider key ${slug} cannot be shared between vendor_mcp and other provider routes.`,
      );
    }
    byOAuthProviderKey.set(
      slug,
      freezeDeepArray(group.toSorted((left, right) => left.key.localeCompare(right.key))),
    );
  }

  const frozenDefinitions = freezeDeepArray(
    definitions.toSorted((left, right) => left.key.localeCompare(right.key)),
  );

  const listByOAuthProviderKeyExact = (slug: string): readonly ProviderDefinition[] => {
    if (typeof slug !== "string") return freezeDeepArray([]);
    const trimmed = slug.trim();
    if (!trimmed) return freezeDeepArray([]);
    return byOAuthProviderKey.get(trimmed) ?? freezeDeepArray([]);
  };

  const getByOAuthProviderKeyExact = (slug: string): ProviderDefinition | undefined => {
    const matches = listByOAuthProviderKeyExact(slug);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const resolveExact = (identifier: string): ProviderDefinition | undefined => {
    if (typeof identifier !== "string") return undefined;
    // Trim only for call ergonomics. No case folding, slug rewriting, or partial matching.
    const trimmed = identifier.trim();
    if (!trimmed) return undefined;
    // Prefer exclusive canonical identifiers; shared OAuth app keys stay unresolved.
    return (
      byKey.get(trimmed) ??
      byAlias.get(trimmed) ??
      byKey.get(trimmed.replaceAll("-", "_")) ??
      getByOAuthProviderKeyExact(trimmed)
    );
  };

  const registry: ProviderDefinitionRegistry = {
    definitions: frozenDefinitions,
    list: () => frozenDefinitions,
    getByKey: (key) => {
      if (typeof key !== "string") return undefined;
      const trimmed = key.trim();
      return byKey.get(trimmed);
    },
    getByAlias: (alias) => {
      if (typeof alias !== "string") return undefined;
      const trimmed = alias.trim();
      return byAlias.get(trimmed);
    },
    getByOAuthProviderKey: getByOAuthProviderKeyExact,
    listByOAuthProviderKey: listByOAuthProviderKeyExact,
    resolve: resolveExact,
  };

  return Object.freeze(registry);
}
