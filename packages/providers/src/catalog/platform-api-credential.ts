import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { PLATFORM_API_CREDENTIAL_ANALYTICS_INPUTS } from "./platform-api-credential-analytics.ts";
import { PLATFORM_API_CREDENTIAL_CONTENT_INPUTS } from "./platform-api-credential-content.ts";
import { PLATFORM_API_CREDENTIAL_GROWTH_INPUTS } from "./platform-api-credential-growth.ts";
import { PLATFORM_API_CREDENTIAL_MESSAGING_INPUTS } from "./platform-api-credential-messaging.ts";

/** Platform credential definitions absent from the baseline provider registry. */
export const PLATFORM_API_CREDENTIAL_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    ...PLATFORM_API_CREDENTIAL_ANALYTICS_INPUTS,
    ...PLATFORM_API_CREDENTIAL_GROWTH_INPUTS,
    ...PLATFORM_API_CREDENTIAL_MESSAGING_INPUTS,
    ...PLATFORM_API_CREDENTIAL_CONTENT_INPUTS,
  ]);
