import {
  agentDeploymentConfigContentHash,
  agentManifestContentHash,
  canonicalAgentDeploymentConfigJson,
  canonicalAgentManifestJson,
  decodeAgentDeploymentConfig,
  decodeAgentManifest,
} from "./canonical.ts";
import type { AgentDeploymentConfigV1, AgentManifestV1 } from "./schema.ts";
import {
  agentDeploymentConfigSemanticIssues,
  agentManifestDepthIssue,
  agentManifestSemanticIssues,
} from "./semantics.ts";

export interface AgentManifestValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly severity: "error";
}

export type AgentManifestValidationResult =
  | {
      readonly canonicalJson: string;
      readonly contentHash: string;
      readonly manifest: AgentManifestV1;
      readonly ok: true;
    }
  | {
      readonly issues: readonly AgentManifestValidationIssue[];
      readonly ok: false;
    };

export type AgentDeploymentConfigValidationResult =
  | {
      readonly canonicalJson: string;
      readonly config: AgentDeploymentConfigV1;
      readonly contentHash: string;
      readonly ok: true;
    }
  | {
      readonly issues: readonly AgentManifestValidationIssue[];
      readonly ok: false;
    };

export function validateAgentDeploymentConfig(
  configInput: unknown,
  manifestInput: unknown,
): AgentDeploymentConfigValidationResult {
  let config: AgentDeploymentConfigV1;
  let manifest: AgentManifestV1;
  try {
    config = decodeAgentDeploymentConfig(configInput);
    manifest = assertValidAgentManifest(manifestInput);
  } catch (cause) {
    return {
      issues: [
        {
          code: "invalid_agent_deployment_config",
          message:
            cause instanceof Error ? cause.message : "Agent deployment configuration is invalid.",
          path: "/",
          severity: "error",
        },
      ],
      ok: false,
    };
  }

  const issues = agentDeploymentConfigSemanticIssues(config, manifest).map((issue) => ({
    ...issue,
    severity: "error" as const,
  }));

  if (issues.length > 0) return { issues, ok: false };
  return {
    canonicalJson: canonicalAgentDeploymentConfigJson(config),
    config,
    contentHash: agentDeploymentConfigContentHash(config),
    ok: true,
  };
}

export function validateAgentManifest(input: unknown): AgentManifestValidationResult {
  const depthIssue = agentManifestDepthIssue(input);
  if (depthIssue) return { issues: [{ ...depthIssue, severity: "error" }], ok: false };
  let manifest: AgentManifestV1;
  try {
    manifest = decodeAgentManifest(input);
  } catch (cause) {
    return {
      issues: [
        {
          code: "invalid_agent_manifest",
          message: cause instanceof Error ? cause.message : "Agent manifest validation failed.",
          path: "/",
          severity: "error",
        },
      ],
      ok: false,
    };
  }

  const issues = agentManifestSemanticIssues(manifest).map((issue) => ({
    ...issue,
    severity: "error" as const,
  }));
  if (issues.length > 0) return { issues, ok: false };
  return {
    canonicalJson: canonicalAgentManifestJson(manifest),
    contentHash: agentManifestContentHash(manifest),
    manifest,
    ok: true,
  };
}

export function assertValidAgentManifest(input: unknown): AgentManifestV1 {
  const result = validateAgentManifest(input);
  if (result.ok) return result.manifest;
  throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
}
