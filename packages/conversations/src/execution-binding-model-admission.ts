import type { AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { AdmitManifest, AgentModelAdmissionScope } from "@deployments-ai/db";
import { ConversationError } from "./submission.ts";

/**
 * A binding manifest references a model or tool that publish would reject. The code is the
 * admission reason publish reports, for example `model_not_allowed_by_environment_policy` or
 * `tool_outside_data_boundary`.
 */
export class ExecutionBindingManifestNotAdmittedError extends ConversationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExecutionBindingManifestNotAdmittedError";
  }
}

/**
 * Admits a binding manifest exactly like publish: preview and evaluation bindings must not run
 * what a release could not be published with. A release source passes its agent definition so
 * the agent's operator grants apply.
 */
export async function assertExecutionBindingManifestAdmitted(
  admitManifest: AdmitManifest,
  scope: AgentModelAdmissionScope,
  manifest: AgentManifestV1,
) {
  const issues = await admitManifest(scope, manifest);
  const [first] = issues;
  if (!first) return;
  throw new ExecutionBindingManifestNotAdmittedError(
    first.code,
    issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
  );
}
