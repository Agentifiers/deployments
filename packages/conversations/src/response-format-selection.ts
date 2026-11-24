import {
  canonicalResponseFormatJson,
  type AgentManifestV1,
  type AgentResponseFormat,
} from "@deployments-ai/agent-manifest";
import { ConversationError, type SubmitConversationTurnInput } from "./submission.ts";

// Automation triggers keep their own output contract, matching responseDepthPolicy.
const RELEASE_FORMAT_EXCLUDED_TRIGGERS: Readonly<Record<string, true>> = {
  heartbeat: true,
  schedule: true,
};

/** The release-pinned structured response contract applied to a trigger, if any. */
function releaseResponseFormatForTrigger(
  manifest: AgentManifestV1,
  trigger: string,
): AgentResponseFormat | undefined {
  return Object.hasOwn(RELEASE_FORMAT_EXCLUDED_TRIGGERS, trigger)
    ? undefined
    : manifest.spec.runtime?.responseFormat;
}

/**
 * Resolves the run's effective structured response contract. A request-level format wins only
 * when it is canonically equal to the release-pinned format; a caller cannot silently replace
 * the release contract.
 */
export function effectiveResponseFormat(
  input: Pick<SubmitConversationTurnInput, "responseFormat" | "trigger">,
  manifest: AgentManifestV1,
): AgentResponseFormat | undefined {
  const released = releaseResponseFormatForTrigger(manifest, (input.trigger ?? "api").trim());
  if (input.responseFormat === undefined) return released;
  if (
    released !== undefined &&
    canonicalResponseFormatJson(released) !== canonicalResponseFormatJson(input.responseFormat)
  ) {
    throw new ConversationError(
      "response_format_conflict",
      "The requested responseFormat differs from the agent release's responseFormat.",
    );
  }
  return input.responseFormat;
}
