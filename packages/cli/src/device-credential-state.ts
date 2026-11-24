import type { CliConfig, ProfileConfig } from "./types.ts";

export function sameApiOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function activeDeviceCredential(profile: ProfileConfig, apiUrl: string): string | undefined {
  if (profile.credentialState && profile.credentialState !== "active") return undefined;
  return profile.apiKey &&
    profile.apiKeyExpiresAt &&
    sameApiOrigin(apiUrl, profile.apiUrl) &&
    Date.parse(profile.apiKeyExpiresAt) > Date.now() + 60_000
    ? profile.apiKey
    : undefined;
}

export function sameDeviceCredential(left: ProfileConfig, right: ProfileConfig): boolean {
  return (
    left.apiUrl === right.apiUrl &&
    left.apiKey === right.apiKey &&
    left.apiKeyExpiresAt === right.apiKeyExpiresAt &&
    left.refreshToken === right.refreshToken
  );
}

export function isDefinitiveRefreshRejection(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["invalid_client", "invalid_grant", "unauthorized_client"].includes(value)
  );
}

export type DeviceCredential = Required<
  Pick<ProfileConfig, "apiKey" | "apiKeyExpiresAt" | "refreshToken">
>;

function unchangedProfile(
  config: CliConfig,
  profileName: string,
  expected: ProfileConfig,
): ProfileConfig | undefined {
  const profile = Object.hasOwn(config.profiles, profileName)
    ? config.profiles[profileName]
    : undefined;
  return profile && sameDeviceCredential(expected, profile) ? profile : undefined;
}

export function replaceDeviceCredential(
  config: CliConfig,
  profileName: string,
  expected: ProfileConfig,
  credential: DeviceCredential,
): CliConfig | undefined {
  const profile = unchangedProfile(config, profileName, expected);
  if (!profile) return undefined;
  return {
    ...config,
    profiles: { ...config.profiles, [profileName]: { ...profile, ...credential } },
  };
}

export function markReauthenticationRequired(
  config: CliConfig,
  profileName: string,
  expected: ProfileConfig,
): CliConfig {
  const profile = unchangedProfile(config, profileName, expected);
  if (!profile) return config;
  const {
    apiKey: _apiKey,
    apiKeyExpiresAt: _apiKeyExpiresAt,
    refreshToken: _refreshToken,
    ...profileWithoutCredential
  } = profile;
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [profileName]: {
        ...profileWithoutCredential,
        credentialState: "reauthentication-required",
      },
    },
  };
}
