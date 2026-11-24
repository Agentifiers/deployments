import type { SlackDataVisualizationSpec } from "./data-visualization.ts";
import { googleAdsVisualization } from "./provider-visualization-marketing.ts";
import {
  quickbooksVisualization,
  zendeskVisualization,
} from "./provider-visualization-operations.ts";
import type { ProviderSlackVisualizationInput } from "./provider-visualization-shared.ts";
import {
  normalizedProvider,
  supportsProviderToolVisualization,
} from "./provider-visualization-shared.ts";

export type { ProviderSlackVisualizationInput } from "./provider-visualization-shared.ts";

export function buildProviderSlackVisualizations(
  input: ProviderSlackVisualizationInput,
): SlackDataVisualizationSpec[] {
  const provider = normalizedProvider(input.provider);
  if (!supportsProviderToolVisualization(provider, input.toolName)) return [];
  if (provider === "google_ads") return googleAdsVisualization(input.value);
  if (provider === "quickbooks") return quickbooksVisualization(input.value);
  if (provider === "zendesk") return zendeskVisualization(input.value);
  return [];
}
