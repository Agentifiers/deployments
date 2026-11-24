import type { AgentManifestV1 } from "./schema.ts";
import type { AgentManifestSemanticIssue } from "./semantics.ts";

/**
 * Hosted code tools are data-owned extension adapters, so a manifest names them like any other
 * tool. Callers that resolve those names against the environment's adapters (release publish)
 * pass the hosted code subset here; the manifest must then provide an agent sandbox that can
 * enforce per-execution network isolation.
 */
export function hostedCodeToolIssues(
  manifest: AgentManifestV1,
  hostedCodeToolNames: ReadonlySet<string>,
): readonly AgentManifestSemanticIssue[] {
  const issues: AgentManifestSemanticIssue[] = [];
  const sandbox = manifest.spec.sandbox;
  for (const [index, tool] of (manifest.spec.capabilities?.tools ?? []).entries()) {
    if (!hostedCodeToolNames.has(tool.name)) continue;
    const path = `/spec/capabilities/tools/${index}`;
    if (sandbox.mode === "none") {
      issues.push({
        code: "hosted_code_tool_without_sandbox",
        message: `Hosted code tool ${tool.name} requires a run-ephemeral or thread-persistent sandbox.`,
        path: `${path}/name`,
      });
    }
    if (tool.authorization === "workspace") {
      issues.push({
        code: "hosted_code_tool_workspace_authorization",
        message: `Hosted code tool ${tool.name} runs platform-hosted code and cannot bind a workspace authorization.`,
        path: `${path}/authorization`,
      });
    }
  }
  return issues;
}
