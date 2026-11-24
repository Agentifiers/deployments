import { snowflakeNativeHttpToolDefinitions } from "./snowflake.ts";
import type { ProviderNativeHttpToolDefinition } from "../core.ts";

export const dataProductNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  ...snowflakeNativeHttpToolDefinitions,
];
