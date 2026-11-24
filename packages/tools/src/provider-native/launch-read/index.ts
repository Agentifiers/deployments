import type { ProviderNativeHttpToolDefinition } from "../core.ts";
import { googleSearchConsoleNativeHttpToolDefinitions } from "./google-search-console.ts";
import { wordpressNativeHttpToolDefinitions } from "./wordpress.ts";

export { googleSearchConsoleNativeHttpToolDefinitions } from "./google-search-console.ts";
export { wordpressNativeHttpToolDefinitions } from "./wordpress.ts";

/** Initial read/connect provider-native tools shared by verticals. */
export const launchReadNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...googleSearchConsoleNativeHttpToolDefinitions,
  ...wordpressNativeHttpToolDefinitions,
];

export const LAUNCH_READ_PROVIDER_NATIVE_TOOL_NAMES = [
  "google_search_console.sites.list",
  "google_search_console.performance.query",
  "wordpress.posts.list",
  "wordpress.pages.list",
] as const;
