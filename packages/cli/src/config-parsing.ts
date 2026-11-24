import { CliError, ExitCode } from "./errors.ts";
import { validateApiUrl } from "./profile-resolution-helpers.ts";
import type { CliConfig, ProfileConfig } from "./types.ts";

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim().length > 0 && value === value.trim())
  );
}

function isProfile(value: unknown): value is ProfileConfig {
  const profile = value as ProfileConfig;
  const credentialState = profile?.credentialState ?? "active";
  const hasExpiry = profile?.apiKeyExpiresAt !== undefined;
  const hasRefresh = profile?.refreshToken !== undefined;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof profile.apiUrl === "string" &&
    profile.apiUrl.trim().length > 0 &&
    profile.apiUrl === profile.apiUrl.trim() &&
    isOptionalNonEmptyString(profile.apiKey) &&
    isOptionalNonEmptyString(profile.apiKeyExpiresAt) &&
    isOptionalNonEmptyString(profile.refreshToken) &&
    isOptionalNonEmptyString(profile.refreshAttemptId) &&
    isOptionalNonEmptyString(profile.refreshStartedAt) &&
    isOptionalNonEmptyString(profile.organizationId) &&
    isOptionalNonEmptyString(profile.projectId) &&
    isOptionalNonEmptyString(profile.environmentId) &&
    isOptionalNonEmptyString(profile.workspaceId) &&
    (profile.mock === undefined || typeof profile.mock === "boolean") &&
    ["active", "refresh-in-progress", "reauthentication-required"].includes(credentialState) &&
    (credentialState === "active"
      ? (!hasRefresh || hasExpiry) &&
        profile.refreshAttemptId === undefined &&
        profile.refreshStartedAt === undefined
      : credentialState === "refresh-in-progress"
        ? !profile.apiKey &&
          !profile.apiKeyExpiresAt &&
          !profile.refreshToken &&
          Boolean(profile.refreshAttemptId) &&
          Boolean(profile.refreshStartedAt)
        : !profile.apiKey &&
          !profile.apiKeyExpiresAt &&
          !profile.refreshToken &&
          profile.refreshAttemptId === undefined &&
          profile.refreshStartedAt === undefined) &&
    (!hasExpiry ||
      (profile.apiKey !== undefined &&
        Number.isFinite(Date.parse(profile.apiKeyExpiresAt!)) &&
        new Date(Date.parse(profile.apiKeyExpiresAt!)).toISOString() === profile.apiKeyExpiresAt))
  );
}

export function parseConfig(value: unknown): CliConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("Invalid CLI config: expected a JSON object.", ExitCode.validation);
  }
  const record = value as Partial<CliConfig>;
  if (record.version !== 1) {
    throw new CliError(
      `Unsupported CLI config version: ${String(record.version ?? "missing")}`,
      ExitCode.validation,
    );
  }
  if (
    typeof record.currentProfile !== "string" ||
    record.currentProfile.trim().length === 0 ||
    record.currentProfile !== record.currentProfile.trim()
  ) {
    throw new CliError(
      "Invalid CLI config: currentProfile must be a non-empty string.",
      ExitCode.validation,
    );
  }
  if (
    typeof record.profiles !== "object" ||
    record.profiles === null ||
    Array.isArray(record.profiles)
  ) {
    throw new CliError("Invalid CLI config: profiles must be a JSON object.", ExitCode.validation);
  }
  const entries = Object.entries(record.profiles);
  if (entries.length === 0) {
    throw new CliError(
      "Invalid CLI config: at least one profile is required.",
      ExitCode.validation,
    );
  }
  for (const [profileName, profile] of entries) {
    if (!profileName || profileName !== profileName.trim() || !isProfile(profile)) {
      throw new CliError(
        `Invalid CLI config: profile ${JSON.stringify(profileName)} is malformed.`,
        ExitCode.validation,
      );
    }
    validateApiUrl(profile.apiUrl);
  }
  const profiles = Object.fromEntries(entries) as Record<string, ProfileConfig>;
  if (!Object.hasOwn(profiles, record.currentProfile)) {
    throw new CliError(
      `Invalid CLI config: current profile ${JSON.stringify(record.currentProfile)} does not exist.`,
      ExitCode.validation,
    );
  }
  return { version: 1, currentProfile: record.currentProfile, profiles };
}
