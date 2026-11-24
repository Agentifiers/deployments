import { zendeskNativeHttpToolDefinitions } from "./zendesk.ts";
import type { ProviderNativeHttpToolDefinition } from "../core.ts";

export { zendeskNativeHttpToolDefinitions } from "./zendesk.ts";

export const supportNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...zendeskNativeHttpToolDefinitions,
];
