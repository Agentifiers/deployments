import { quickbooksNativeHttpToolDefinitions } from "./quickbooks.ts";
import type { ProviderNativeHttpToolDefinition } from "../core.ts";

export { quickbooksNativeHttpToolDefinitions } from "./quickbooks.ts";

export const financeNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...quickbooksNativeHttpToolDefinitions,
];
