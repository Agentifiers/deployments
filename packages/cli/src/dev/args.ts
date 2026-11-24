import {
  PREVIEW_MAX_TTL_SECONDS,
  PREVIEW_MIN_TTL_SECONDS,
} from "@deployments-ai/api-contract/runtime";
import type { ArgsDef } from "citty";
import { commonArgs, value, type LooseArgs } from "../command-runtime.ts";
import { CliError, ExitCode } from "../errors.ts";

export const devArgs = {
  profile: commonArgs.profile,
  "api-url": commonArgs["api-url"],
  "api-key": commonArgs["api-key"],
  org: commonArgs.org,
  project: commonArgs.project,
  env: commonArgs.env,
  workspace: commonArgs.workspace,
  mock: commonArgs.mock,
  live: commonArgs.live,
  color: commonArgs.color,
  manifest: {
    type: "positional",
    description: "Agent manifest JSON file",
    required: true,
    valueHint: "manifest.json",
  },
  "runtime-config": {
    type: "string",
    description: "Runtime configuration JSON file",
    valueHint: "file",
  },
  "config-from-deployment": {
    type: "string",
    description: "Snapshot the runtime configuration of an agent deployment",
    valueHint: "id",
  },
  message: {
    type: "string",
    description: "Send one message, stream the reply, and exit",
    valueHint: "text",
  },
  ttl: {
    type: "string",
    description: `Preview lifetime in seconds (${PREVIEW_MIN_TTL_SECONDS}-${PREVIEW_MAX_TTL_SECONDS})`,
    valueHint: "seconds",
  },
} as const satisfies ArgsDef;

export type DevRuntimeConfigSource =
  | { readonly type: "default" }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "deployment"; readonly agentDeploymentId: string };

export interface DevOptions {
  readonly manifestPath: string;
  readonly runtimeConfig: DevRuntimeConfigSource;
  /** One-shot mode when present; the interactive session otherwise. */
  readonly message?: string;
  readonly ttlSeconds?: number;
}

function optionalText(args: LooseArgs, name: string): string | undefined {
  const raw = value(args, name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CliError(`--${name} must not be empty.`, ExitCode.validation);
  }
  return raw;
}

function ttlSeconds(args: LooseArgs): number | undefined {
  const raw = optionalText(args, "ttl");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (
    !/^\d+$/u.test(raw.trim()) ||
    parsed < PREVIEW_MIN_TTL_SECONDS ||
    parsed > PREVIEW_MAX_TTL_SECONDS
  ) {
    throw new CliError(
      `--ttl must be an integer between ${PREVIEW_MIN_TTL_SECONDS} and ${PREVIEW_MAX_TTL_SECONDS} seconds.`,
      ExitCode.validation,
    );
  }
  return parsed;
}

export function parseDevOptions(args: LooseArgs): DevOptions {
  const manifestPath = optionalText(args, "manifest");
  if (manifestPath === undefined) {
    throw new CliError("A manifest file is required.", ExitCode.usage);
  }
  const runtimeConfigPath = optionalText(args, "runtime-config");
  const agentDeploymentId = optionalText(args, "config-from-deployment");
  if (runtimeConfigPath !== undefined && agentDeploymentId !== undefined) {
    throw new CliError(
      "--runtime-config and --config-from-deployment are mutually exclusive.",
      ExitCode.usage,
    );
  }
  const message = optionalText(args, "message");
  const ttl = ttlSeconds(args);
  return {
    manifestPath,
    runtimeConfig:
      runtimeConfigPath !== undefined
        ? { type: "file", path: runtimeConfigPath }
        : agentDeploymentId !== undefined
          ? { type: "deployment", agentDeploymentId }
          : { type: "default" },
    ...(message !== undefined ? { message } : {}),
    ...(ttl !== undefined ? { ttlSeconds: ttl } : {}),
  };
}
