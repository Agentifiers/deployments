import {
  decodeAgentDeploymentConfig,
  validateAgentManifest,
  type AgentDeploymentConfigV1,
  type AgentManifestV1,
} from "@deployments-ai/agent-manifest";
import { readFile } from "node:fs/promises";
import { CliError, errorMessage, ExitCode } from "../errors.ts";

export interface LoadedManifest {
  readonly manifest: AgentManifestV1;
  /** Canonical manifest hash, identical to the hash the platform records for a preview. */
  readonly contentHash: string;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new CliError(`Unable to read ${label}: ${path}`, ExitCode.validation);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new CliError(
      `${label} is not valid JSON (${path}): ${errorMessage(error)}`,
      ExitCode.validation,
    );
  }
}

/** Reads and validates a manifest file with the same rules the platform applies to previews. */
export async function loadManifest(path: string): Promise<LoadedManifest> {
  const validation = validateAgentManifest(await readJsonFile(path, "Agent manifest"));
  if (!validation.ok) {
    throw new CliError(
      [
        `Agent manifest is invalid: ${path}`,
        ...validation.issues.map((issue) => `  ${issue.path}: ${issue.message}`),
      ].join("\n"),
      ExitCode.validation,
    );
  }
  return { contentHash: validation.contentHash, manifest: validation.manifest };
}

export async function loadRuntimeConfig(path: string): Promise<AgentDeploymentConfigV1> {
  const input = await readJsonFile(path, "Runtime configuration");
  try {
    return decodeAgentDeploymentConfig(input);
  } catch (error) {
    throw new CliError(
      `Runtime configuration is invalid (${path}): ${errorMessage(error)}`,
      ExitCode.validation,
    );
  }
}
