import {
  loadExecutionBindingHostedCodeTool,
  loadReleaseHostedCodeTool,
  type AgentReleaseHostedCodeTool,
  type DynamoDatabaseService,
  type ExecutionBindingHostedCodeTool,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";

type ToolAdapter = Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;

/**
 * Hosted code executes exactly what the run's execution source pinned: the release's pin for
 * deployment runs and release-sourced bound runs, the binding's own pin for manifest-sourced bound
 * runs. The live adapter only has to remain the same active adapter (archiving it disables the
 * tool); its current artifact, schemas, and limits never replace the pin. Runs without a pin
 * cannot use the tool.
 */
export async function pinnedHostedCodeDefinition(
  database: DynamoDatabaseService,
  adapter: ToolAdapter,
  definition: ToolAdapterDefinition,
  context: {
    readonly agentReleaseId?: Ulid | undefined;
    readonly executionBindingId?: Ulid | undefined;
    readonly organizationId: Ulid;
  },
): Promise<ToolAdapterDefinition | undefined> {
  let pin: AgentReleaseHostedCodeTool | ExecutionBindingHostedCodeTool | undefined;
  if (context.agentReleaseId) {
    pin = await loadReleaseHostedCodeTool(database, {
      agentReleaseId: context.agentReleaseId,
      organizationId: context.organizationId,
      toolName: adapter.data.name,
    });
  } else if (context.executionBindingId) {
    pin = await loadExecutionBindingHostedCodeTool(
      database,
      {
        executionBindingId: context.executionBindingId,
        organizationId: context.organizationId,
        toolName: adapter.data.name,
      },
      new Date(),
    );
  }
  if (
    !pin ||
    pin.data.toolAdapterId !== adapter.data.id ||
    pin.data.environmentId !== adapter.data.environmentId ||
    pin.data.projectId !== adapter.data.projectId
  ) {
    return undefined;
  }
  const reference = adapter.data.authSecretRef;
  const credential =
    reference && "store" in reference && reference.store === "dynamodb-kms"
      ? { credentialId: reference.credentialId, generation: reference.generation }
      : undefined;
  return {
    ...definition,
    effect: pin.data.effect,
    execution: {
      artifact: pin.data.artifact,
      contentHash: pin.data.contentHash,
      ...(credential && pin.data.secretNames.length > 0 ? { credential } : {}),
      entrypoint: pin.data.entrypoint,
      language: pin.data.language,
      memoryMiB: pin.data.memoryMiB,
      network: pin.data.network,
      secretNames: pin.data.secretNames,
      sourceLanguage: pin.data.sourceLanguage,
      timeoutMs: pin.data.timeoutMs,
      type: "hosted_code",
    },
    inputSchema: pin.data.inputSchema,
    outputSchema: pin.data.outputSchema,
    providerOutboundMutation: pin.data.effect !== "read",
  };
}
