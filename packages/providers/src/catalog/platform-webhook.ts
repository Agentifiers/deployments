import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { webhookChallengeVerification, webhookDefinition } from "./shared.ts";

/** Inbound webhook route; credentials are provisioned by the webhook lifecycle, not this catalog. */
export const PLATFORM_WEBHOOK_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    webhookDefinition({
      key: "rb2b",
      displayName: "RB2B",
      category: "visitor_identification",
      supportsMultipleAccounts: true,
      verification: webhookChallengeVerification(
        "Generate the tokenized inbound URL, paste it into RB2B, and use Send Test Event before binding the destination.",
      ),
      tools: Object.freeze(["rb2b.visitor_events.receive"]),
      status: "configured",
    }),
  ]);
