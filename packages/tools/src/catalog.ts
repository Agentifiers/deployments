import { appToolAdapterDefinitions } from "./apps.ts";
import { artifactBuilderToolAdapterDefinitions } from "./artifact-builders.ts";
import { artifactHandoffToolAdapterDefinitions } from "./artifact-handoff.ts";
import { artifactLifecycleToolAdapterDefinitions } from "./artifact-lifecycle.ts";
import { attachmentToolAdapterDefinitions } from "./attachments.ts";
import { agentDelegationToolAdapterDefinitions } from "./agent-delegation.ts";
import { agentRegistryToolAdapterDefinitions } from "./agent-registry.ts";
import { browserToolAdapterDefinitions } from "./browser.ts";
import { brainToolAdapterDefinitions } from "./brains.ts";
import { codeToolAdapterDefinitions } from "./code.ts";
import { computerToolAdapterDefinitions } from "./computer.ts";
import { managedSkillToolAdapterDefinitions } from "./managed-skills.ts";
import { memoryToolAdapterDefinitions } from "./memory.ts";
import { providerApiToolAdapterDefinitions } from "./provider-api.ts";
import { providerNativeToolAdapterDefinitions } from "./provider-native/index.ts";
import { sandboxFileToolAdapterDefinitions } from "./sandbox-files.ts";
import { scheduleToolAdapterDefinitions } from "./schedule.ts";
import type { ToolAdapterDefinition } from "./types.ts";
import { selfHostedWebToolDefinitions } from "./web.ts";
import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";

const rawPlatformToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  ...agentDelegationToolAdapterDefinitions,
  ...agentRegistryToolAdapterDefinitions,
  ...appToolAdapterDefinitions,
  ...artifactBuilderToolAdapterDefinitions,
  ...artifactHandoffToolAdapterDefinitions,
  ...artifactLifecycleToolAdapterDefinitions,
  ...attachmentToolAdapterDefinitions,
  ...browserToolAdapterDefinitions,
  ...brainToolAdapterDefinitions,
  ...codeToolAdapterDefinitions,
  ...computerToolAdapterDefinitions,
  ...managedSkillToolAdapterDefinitions,
  ...memoryToolAdapterDefinitions,
  ...providerApiToolAdapterDefinitions,
  ...providerNativeToolAdapterDefinitions,
  ...sandboxFileToolAdapterDefinitions,
  ...scheduleToolAdapterDefinitions,
  ...selfHostedWebToolDefinitions,
] as const;

function normalizeProviderToolAdapter(definition: ToolAdapterDefinition): ToolAdapterDefinition {
  if (!definition.provider) return definition;
  const provider = codeProviderDefinitionRegistry().resolve(definition.provider);
  const requiredScopes = [
    ...(definition.authorizationScopes ?? []),
    ...(definition.requiredScopes ?? []),
  ];
  const registeredScopes = new Set([
    ...(provider?.authorizationScopes ?? []),
    ...(provider?.defaultScopes ?? []),
  ]);
  const unavailable =
    !provider ||
    (provider.status !== "configured" && provider.status !== "verified") ||
    !provider.tools.includes(definition.toolName) ||
    requiredScopes.some((scope) => !registeredScopes.has(scope));
  return {
    ...definition,
    provider: provider?.key ?? definition.provider,
    ...(definition.effect === "write" ? { providerOutboundMutation: true } : {}),
    ...(unavailable ? { defaultPolicyAction: "deny", status: "archived" } : {}),
  };
}

export const platformToolAdapterDefinitions: readonly ToolAdapterDefinition[] =
  rawPlatformToolAdapterDefinitions.map(normalizeProviderToolAdapter);

export function findPlatformToolAdapterDefinition(toolName: string) {
  return platformToolAdapterDefinitions.find((definition) => definition.toolName === toolName);
}
