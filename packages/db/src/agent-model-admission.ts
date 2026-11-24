import type { AgentManifestSemanticIssue, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { validationMessage } from "./agent-lifecycle.ts";
import type { AgentRelease } from "./agent-lifecycle-types.ts";
import { PersistenceError } from "./persistence-types.ts";

/**
 * The environment whose model policy decides which models a manifest may reference, and the agent
 * definition whose runs make the model calls (absent for an inline preview/evaluation manifest).
 * The agent selects the operator model grants that apply.
 */
export interface AgentModelAdmissionScope {
  readonly agentDefinitionId?: string;
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

/**
 * Checks what a manifest references (models, tools) against the environment's policies and the
 * organization's data boundary; returns one issue per rejected reference.
 */
export type AdmitManifest = (
  scope: AgentModelAdmissionScope,
  manifest: AgentManifestV1,
) => Promise<readonly AgentManifestSemanticIssue[]>;

/** Runs each admission in order and reports every issue they find. */
export function composeManifestAdmission(...admissions: AdmitManifest[]): AdmitManifest {
  return async (scope, manifest) => {
    const issues: AgentManifestSemanticIssue[] = [];
    for (const admit of admissions) issues.push(...(await admit(scope, manifest)));
    return issues;
  };
}

export type ManifestAdmissionTarget =
  | AgentRelease
  | { readonly manifest: AgentManifestV1; readonly scope: AgentModelAdmissionScope };

/** Throws `unprocessable` with the first issue's code when a manifest reference is not admitted. */
export async function assertManifestAdmitted(
  admitManifest: AdmitManifest,
  target: ManifestAdmissionTarget,
) {
  const { manifest, scope } =
    "itemType" in target
      ? {
          manifest: target.data.manifest,
          scope: {
            agentDefinitionId: target.data.agentDefinitionId,
            environmentId: target.data.environmentId,
            organizationId: target.data.organizationId,
            projectId: target.data.projectId,
          },
        }
      : target;
  const issues = await admitManifest(scope, manifest);
  if (issues[0]) {
    throw new PersistenceError("unprocessable", issues[0].code, validationMessage(issues));
  }
}
