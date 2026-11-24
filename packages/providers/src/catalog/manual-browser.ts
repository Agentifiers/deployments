import type { ProviderDefinitionInput } from "../provider-definitions.ts";

/** Manual-only provider routes retain explicit catalog semantics without fake API credentials. */
export const MANUAL_BROWSER_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([]);
