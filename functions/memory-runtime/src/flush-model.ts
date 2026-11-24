import type { ObservabilitySourceContext, Ulid } from "@deployments-ai/db";
import { memoryFlushOutputTokenLimit, type MemoryPlatformScope } from "@deployments-ai/memory";
import {
  catalogLookupModelIds,
  isCuratedModelId,
  MODEL_CATALOG_PROVIDERS,
  modelContextLimits,
  modelProviderForId,
  modelServiceTokenRequest,
  ModelTokenIssuanceError,
  normalizeModelId,
  type IssuedModelGatewayToken,
  type ModelCatalogRuntimeEntries,
  type ModelCatalogRuntimeEntry,
  type ModelContextBudget,
  type ModelGatewayServiceTokenContext,
  type ModelTokenRequest,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { memoryModelGateway, memoryModelTokenIssuer, runtimeModelComponents } from "./runtime.ts";

const MEMORY_FLUSH_SYSTEM_PROMPT = "Return only a JSON object containing a memories array.";
const MEMORY_FLUSH_MESSAGE_OVERHEAD_TOKENS = 32;
const MEMORY_FLUSH_SYSTEM_PROMPT_TOKENS = new TextEncoder().encode(
  MEMORY_FLUSH_SYSTEM_PROMPT,
).byteLength;

export interface MemoryFlushModelRuntime extends ModelContextBudget {
  readonly modelToolProtocol?: "gemma4" | undefined;
}

/** The run a flush extracts memories from, as its model token names it. */
export interface MemoryFlushTenancy {
  readonly agentId: Ulid;
  readonly runId: Ulid;
  readonly scope: MemoryPlatformScope;
}

export type MemoryFlushModelAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

function memoryFlushTokenContext(tenancy: MemoryFlushTenancy): ModelGatewayServiceTokenContext {
  return {
    agentDefinitionId: tenancy.agentId,
    environmentId: tenancy.scope.environmentId,
    organizationId: tenancy.scope.organizationId,
    projectId: tenancy.scope.projectId,
    runId: tenancy.runId,
    ...(tenancy.scope.workspaceId ? { workspaceId: tenancy.scope.workspaceId } : {}),
  };
}

/**
 * Asks the memory token issuer whether the run's environment admits `modelId`, under the same
 * policy, catalog, and operator grants that admitted the run's agent model. Only a
 * `model_not_admitted` or `model_outside_data_boundary` refusal is an answer; any other failure
 * would also stop the agent's model.
 */
export async function admitMemoryFlushModel(
  modelId: string,
  tenancy: MemoryFlushTenancy,
  issue: (
    request: ModelTokenRequest,
  ) => Promise<IssuedModelGatewayToken> = memoryModelTokenIssuer(),
): Promise<MemoryFlushModelAdmission> {
  try {
    await issue(
      modelServiceTokenRequest([normalizeModelId(modelId)], {
        context: memoryFlushTokenContext(tenancy),
      }),
    );
    return { admitted: true };
  } catch (cause) {
    if (
      cause instanceof ModelTokenIssuanceError &&
      (cause.code === "model_not_admitted" || cause.code === "model_outside_data_boundary")
    ) {
      return { admitted: false, reason: cause.message };
    }
    throw cause;
  }
}

/**
 * The synchronized catalog metadata of a non-curated flush model, as run admission carried it for
 * the agent runtime: catalog-admitted models need no explicit manifest budgets, so the flush sizes
 * its prompt and meters cost from the same entry. A retired entry still describes the model the
 * completed run used. Curated models and models without an entry return undefined.
 */
export async function memoryFlushModelCatalog(
  modelId: string,
  getEntries: (
    modelIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ModelCatalogRuntimeEntry>>,
): Promise<ModelCatalogRuntimeEntries | undefined> {
  const [catalogModelId] = catalogLookupModelIds([modelId]);
  if (
    !catalogModelId ||
    isCuratedModelId(catalogModelId) ||
    !(MODEL_CATALOG_PROVIDERS as readonly string[]).includes(modelProviderForId(catalogModelId))
  ) {
    return undefined;
  }
  const entry = (await getEntries([catalogModelId])).get(catalogModelId);
  return entry
    ? {
        [catalogModelId]: {
          contextWindowTokens: entry.contextWindowTokens,
          ...(entry.maximumOutputTokens !== undefined
            ? { maximumOutputTokens: entry.maximumOutputTokens }
            : {}),
          pricing: entry.pricing,
        },
      }
    : undefined;
}

export function memoryFlushModelBudget(modelId: string, runtime?: ModelContextBudget) {
  const limits = modelContextLimits(normalizeModelId(modelId), runtime);
  const maximumOutputTokens = memoryFlushOutputTokenLimit(limits.maximumOutputTokens);
  return {
    maximumOutputTokens,
    promptInputTokenBudget: Math.max(
      0,
      limits.contextWindowTokens -
        maximumOutputTokens -
        MEMORY_FLUSH_SYSTEM_PROMPT_TOKENS -
        MEMORY_FLUSH_MESSAGE_OVERHEAD_TOKENS,
    ),
  };
}

export async function generateFlushCompletion(
  args: MemoryFlushTenancy & {
    readonly modelId: string;
    readonly modelCallId: string;
    readonly modelRuntime?: MemoryFlushModelRuntime;
    readonly observability: ObservabilitySourceContext;
    readonly prompt: string;
  },
) {
  const modelId = normalizeModelId(args.modelId);
  const { maximumOutputTokens, promptInputTokenBudget } = memoryFlushModelBudget(
    modelId,
    args.modelRuntime,
  );
  if (new TextEncoder().encode(args.prompt).byteLength > promptInputTokenBudget) {
    throw new TypeError(
      `Memory flush prompt exceeds the selected model's ${promptInputTokenBudget}-token input budget.`,
    );
  }
  const { usage } = await runtimeModelComponents();
  // The memory issuer admits the flush model, the agent's or the installation's, under the run's
  // environment policy, catalog, and operator grants, so the token carries the run's full tenancy.
  // One gateway per flush keeps that context bound to this call.
  const gateway = memoryModelGateway(() => memoryFlushTokenContext(args));
  const result = await Effect.runPromise(
    gateway.chatCompletion({
      additionalBody: {
        ...(args.modelRuntime?.modelToolProtocol === "gemma4"
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
        response_format: { type: "json_object" },
        temperature: 0,
      },
      fallbackModelIds: [],
      maxTokens: maximumOutputTokens,
      messages: [
        { content: MEMORY_FLUSH_SYSTEM_PROMPT, role: "system" },
        { content: args.prompt, role: "user" },
      ],
      modelCallId: args.modelCallId,
      ...(args.modelRuntime?.modelCatalog ? { modelCatalog: args.modelRuntime.modelCatalog } : {}),
      modelId,
      runId: args.runId,
      scope: {
        agentId: args.agentId,
        organizationId: args.scope.organizationId,
        runId: args.runId,
        ...(args.scope.workspaceId ? { workspaceId: args.scope.workspaceId } : {}),
      },
    }),
  );
  if (result.usage) {
    await Effect.runPromise(
      usage.record(result.usage, {
        environmentId: args.scope.environmentId,
        observability: args.observability,
        organizationId: args.scope.organizationId,
        projectId: args.scope.projectId,
        runId: args.runId,
        workspaceId: args.observability.workspaceId,
      }),
    );
  }
  if (result.finishReason === "length") {
    throw new TypeError(
      `Memory flush completion exceeded its ${maximumOutputTokens}-token output budget.`,
    );
  }
  return result.assistantMessage ?? "";
}
