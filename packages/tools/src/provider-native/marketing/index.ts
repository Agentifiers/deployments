import { googleAdsNativeHttpToolDefinitions } from "./google-ads.ts";
import type { ProviderNativeHttpToolDefinition } from "../core.ts";

export { googleAdsNativeHttpToolDefinitions } from "./google-ads.ts";

export const adsNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...googleAdsNativeHttpToolDefinitions,
];
