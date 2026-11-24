import { modelProviderForId, providerModelIdForModelId } from "./routing.ts";
import type { ModelGatewayProvider } from "./types.ts";

const REASONING_REPLAY_ROUTES: readonly {
  readonly provider: ModelGatewayProvider;
  readonly providerModelPrefix: string;
}[] = [
  { provider: "openrouter", providerModelPrefix: "anthropic/" },
  { provider: "openrouter", providerModelPrefix: "google/gemini-3" },
  { provider: "openrouter", providerModelPrefix: "openai/gpt-5" },
];

export function reasoningReplaySupported(canonicalModelId: string): boolean {
  const provider = modelProviderForId(canonicalModelId);
  const providerModelId = providerModelIdForModelId(canonicalModelId).toLowerCase();
  return REASONING_REPLAY_ROUTES.some(
    (route) => route.provider === provider && providerModelId.startsWith(route.providerModelPrefix),
  );
}
