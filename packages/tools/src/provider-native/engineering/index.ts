import type { ProviderNativeHttpToolDefinition } from "../core.ts";
import { bitbucketNativeHttpToolDefinitions } from "./bitbucket.ts";

export const engineeringNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...bitbucketNativeHttpToolDefinitions,
];
