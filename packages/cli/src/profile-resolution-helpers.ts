import { validatePlatformBaseUrl } from "@agentifiers/deployments-sdk";
import { CliError, ExitCode } from "./errors.ts";
import type { CliConfig } from "./types.ts";

export const DEFAULT_API_URL = "https://api.us.deployments.ai";

export function defaultConfig(): CliConfig {
  return {
    version: 1,
    currentProfile: "default",
    profiles: {
      default: { apiUrl: DEFAULT_API_URL, mock: false },
    },
  };
}

export function validateApiUrl(apiUrl: string) {
  validatePlatformBaseUrl(apiUrl);
}

/** The value when it is a non-empty string without surrounding whitespace. */
export function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
    ? value
    : undefined;
}

export function resolveProfileName(
  args: Readonly<Record<string, unknown>>,
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (args.profile !== undefined && optional(args.profile) === undefined) {
    throw new CliError("--profile must be a non-empty, unpadded value.", ExitCode.validation);
  }
  if (env.DEPLOYMENTS_PROFILE !== undefined && optional(env.DEPLOYMENTS_PROFILE) === undefined) {
    throw new CliError(
      "DEPLOYMENTS_PROFILE must be a non-empty, unpadded value.",
      ExitCode.validation,
    );
  }
  return optional(args.profile) ?? optional(env.DEPLOYMENTS_PROFILE) ?? config.currentProfile;
}

export interface ScopedValue {
  readonly value?: string;
  readonly precedence: number;
}

export function scopedValue(
  flag: unknown,
  environment: string | undefined,
  profile: string | undefined,
): ScopedValue {
  const flagValue = optional(flag);
  if (flagValue) return { value: flagValue, precedence: 3 };
  if (environment) return { value: environment, precedence: 2 };
  if (profile) return { value: profile, precedence: 1 };
  return { precedence: 0 };
}
