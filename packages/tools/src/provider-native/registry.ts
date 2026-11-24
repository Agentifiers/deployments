import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";

import type { ToolAdapterDefinition } from "../types.ts";
import {
  additionalBusinessNativeHttpToolDefinitions,
  businessNativeHttpToolDefinitions,
} from "./business/index.ts";
import { dataProductNativeHttpToolDefinitions } from "./data-product/index.ts";
import { engineeringNativeHttpToolDefinitions } from "./engineering/index.ts";
import { financeNativeHttpToolDefinitions } from "./finance/index.ts";
import { launchReadNativeHttpToolDefinitions } from "./launch-read/index.ts";
import {
  EXPANDED_ACQUISITION_DEFERRED_DESCRIPTORS,
  expandedAcquisitionNativeHttpToolDefinitions,
} from "./acquisition/index.ts";
import { adsNativeHttpToolDefinitions } from "./marketing/index.ts";
import { microsoftNativeHttpToolDefinitions } from "./microsoft/index.ts";
import { revenueNativeHttpToolDefinitions } from "./revenue/index.ts";
import { supportNativeHttpToolDefinitions } from "./support/index.ts";
import {
  providerNativeToolDefinitionToAdapter,
  type ProviderNativeHttpToolDefinition,
} from "./core.ts";

/** Additional provider-native HTTP definitions grouped by product domain. */
export const expandedCatalogNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  Object.freeze([
    ...expandedAcquisitionNativeHttpToolDefinitions,
    ...additionalBusinessNativeHttpToolDefinitions,
  ]);

export { EXPANDED_ACQUISITION_DEFERRED_DESCRIPTORS };

export const providerNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...engineeringNativeHttpToolDefinitions,
  ...businessNativeHttpToolDefinitions,
  ...dataProductNativeHttpToolDefinitions,
  ...microsoftNativeHttpToolDefinitions,
  ...revenueNativeHttpToolDefinitions,
  ...adsNativeHttpToolDefinitions,
  ...financeNativeHttpToolDefinitions,
  ...supportNativeHttpToolDefinitions,
  ...launchReadNativeHttpToolDefinitions,
  ...expandedAcquisitionNativeHttpToolDefinitions,
];

export type ProviderNativeRegistryIssueCode =
  | "duplicate_tool_name"
  | "missing_provider_definition"
  | "mismatched_tool_provider"
  | "missing_conformance_metadata"
  | "write_requires_approval"
  | "write_effect_metadata";

export type ProviderNativeRegistryIssue = {
  readonly code: ProviderNativeRegistryIssueCode;
  readonly message: string;
  readonly provider: string;
  readonly toolName: string;
};

function normalizedProviderPrefix(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function toolBelongsToProvider(definition: ProviderNativeHttpToolDefinition): boolean {
  const acceptedProviders = definition.acceptedProviders ?? [definition.provider];
  return acceptedProviders.some((provider) => {
    const prefix = normalizedProviderPrefix(provider);
    const toolName = normalizedProviderPrefix(definition.toolName);
    return toolName === prefix || toolName.startsWith(`${prefix}.`);
  });
}

/**
 * Validate the expanded catalog adapter tranche without imposing its richer
 * conformance contract on older provider-native definitions.
 */
export function validateExpandedCatalogNativeRegistry(
  definitions: readonly ProviderNativeHttpToolDefinition[] = expandedCatalogNativeHttpToolDefinitions,
  allDefinitions: readonly ProviderNativeHttpToolDefinition[] = providerNativeHttpToolDefinitions,
): readonly ProviderNativeRegistryIssue[] {
  const issues: ProviderNativeRegistryIssue[] = [];
  const registry = codeProviderDefinitionRegistry();
  const names = new Map<string, ProviderNativeHttpToolDefinition[]>();

  for (const definition of allDefinitions) {
    const existing = names.get(definition.toolName) ?? [];
    existing.push(definition);
    names.set(definition.toolName, existing);
  }
  for (const [toolName, duplicates] of names) {
    if (duplicates.length < 2) continue;
    for (const definition of duplicates) {
      issues.push({
        code: "duplicate_tool_name",
        message: `Provider-native tool name is registered ${duplicates.length} times.`,
        provider: definition.provider,
        toolName,
      });
    }
  }

  for (const definition of definitions) {
    const provider = registry.getByKey(definition.provider);
    if (!provider) {
      issues.push({
        code: "missing_provider_definition",
        message: `No code-owned provider definition exists for ${definition.provider}.`,
        provider: definition.provider,
        toolName: definition.toolName,
      });
    }

    if (!toolBelongsToProvider(definition)) {
      issues.push({
        code: "mismatched_tool_provider",
        message: `Tool name ${definition.toolName} does not use its provider prefix.`,
        provider: definition.provider,
        toolName: definition.toolName,
      });
    }
    if (!definition.conformanceMetadata) {
      issues.push({
        code: "missing_conformance_metadata",
        message: "Expanded catalog adapters require conformance metadata.",
        provider: definition.provider,
        toolName: definition.toolName,
      });
    }
    if (definition.effect === "write" && definition.defaultPolicyAction !== "require_approval") {
      issues.push({
        code: "write_requires_approval",
        message: "Provider-native write tools must require approval by default.",
        provider: definition.provider,
        toolName: definition.toolName,
      });
    }
    if (
      definition.effect === "write" &&
      (!definition.effectMetadata ||
        definition.effectMetadata.outboundMutation !== true ||
        definition.effectMetadata.writeRequiresApproval !== true)
    ) {
      issues.push({
        code: "write_effect_metadata",
        message:
          "Provider-native write tools must declare outbound mutation and approval metadata.",
        provider: definition.provider,
        toolName: definition.toolName,
      });
    }
  }

  return Object.freeze(
    issues.toSorted((left, right) =>
      `${left.code}:${left.toolName}`.localeCompare(`${right.code}:${right.toolName}`),
    ),
  );
}

export function assertExpandedCatalogNativeRegistryIntegrity(): void {
  const issues = validateExpandedCatalogNativeRegistry();
  if (issues.length === 0) return;
  throw new Error(
    [
      "Expanded catalog provider-native registry integrity failed.",
      ...issues.map(
        (issue) => `${issue.code}: ${issue.provider}/${issue.toolName}: ${issue.message}`,
      ),
    ].join("\n"),
  );
}

assertExpandedCatalogNativeRegistryIntegrity();

export const providerNativeToolAdapterDefinitions: readonly ToolAdapterDefinition[] =
  providerNativeHttpToolDefinitions.map((definition) => {
    const provider = codeProviderDefinitionRegistry().resolve(definition.provider);
    const adapter = {
      ...providerNativeToolDefinitionToAdapter(definition),
      provider: provider?.key ?? definition.provider,
    };
    const registeredScopes = new Set([
      ...(provider?.authorizationScopes ?? []),
      ...(provider?.defaultScopes ?? []),
    ]);
    const requiredScopes = [
      ...(definition.authorizationScopes ?? []),
      ...(definition.requiredScopes ?? []),
    ];
    const unavailable =
      !provider ||
      (provider.status !== "configured" && provider.status !== "verified") ||
      !provider.tools.includes(definition.toolName) ||
      requiredScopes.some((scope) => !registeredScopes.has(scope));
    return unavailable
      ? { ...adapter, defaultPolicyAction: "deny" as const, status: "archived" as const }
      : adapter;
  });
