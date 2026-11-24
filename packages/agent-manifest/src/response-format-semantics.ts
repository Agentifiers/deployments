import type { AgentManifestV1 } from "./schema.ts";
import type { AgentManifestSemanticIssue } from "./semantics.ts";

/** A release-pinned structured response replaces depth classification, so both cannot be pinned. */
export function responseFormatSemanticIssues(
  manifest: AgentManifestV1,
): AgentManifestSemanticIssue[] {
  const runtime = manifest.spec.runtime;
  if (runtime?.responseFormat === undefined || runtime.responseDepthPolicy === undefined) return [];
  return [
    {
      code: "structured_response_conflicts_with_depth",
      message:
        "A release-pinned responseFormat cannot be combined with responseDepthPolicy; structured responses bypass depth classification.",
      path: "/spec/runtime/responseFormat",
    },
  ];
}
