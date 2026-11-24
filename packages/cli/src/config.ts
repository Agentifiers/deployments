import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPlatformSdk,
  PlatformApiError,
  PlatformTransportError,
} from "@agentifiers/deployments-sdk";
import { Database } from "bun:sqlite";
import {
  activeDeviceCredential,
  isDefinitiveRefreshRejection,
  markReauthenticationRequired,
  replaceDeviceCredential,
  sameApiOrigin,
} from "./device-credential-state.ts";
import { CliError, ExitCode } from "./errors.ts";
import { configPath } from "./config-location.ts";
import { parseConfig } from "./config-parsing.ts";
import {
  DEFAULT_API_URL,
  defaultConfig,
  optional,
  resolveProfileName,
  scopedValue,
  validateApiUrl,
} from "./profile-resolution-helpers.ts";
import type { CliConfig, ProfileConfig, ResolvedCliContext } from "./types.ts";

export { resolveProfileName } from "./profile-resolution-helpers.ts";
export { configPath } from "./config-location.ts";

export const MOCK_SESSION_API_KEY = "dpl_mock_session";
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const DEVICE_REFRESH_LOCK_TIMEOUT_MS = 35_000;
const DEVICE_REFRESH_TIMEOUT_MS = 30_000;
const DEVICE_REFRESH_RETRY_DELAYS_MS = [250, 1_000] as const;

export function profileForName(config: CliConfig, profileName: string): ProfileConfig | undefined {
  return Object.hasOwn(config.profiles, profileName) ? config.profiles[profileName] : undefined;
}

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<CliConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
  try {
    return parseConfig(JSON.parse(contents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError("Invalid CLI config JSON.", ExitCode.validation);
    }
    throw error;
  }
}

export async function writeConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env) {
  parseConfig(config);
  const path = configPath(env);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r");
    await directoryHandle.sync().finally(() => directoryHandle.close());
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isSqliteBusy(error: unknown): boolean {
  return (
    hasErrorCode(error, "SQLITE_BUSY") ||
    (error instanceof Error && /database is (?:busy|locked)/iu.test(error.message))
  );
}

async function acquireConfigLock(
  env: NodeJS.ProcessEnv,
  scope?: string,
  timeoutMs = CONFIG_LOCK_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  const path = configPath(env);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = scope ? `${path}.${scope}.lock.sqlite` : `${path}.lock.sqlite`;
  const database = new Database(lockPath, { create: true });
  await chmod(lockPath, 0o600);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      database.exec("BEGIN EXCLUSIVE");
      return async () => {
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      };
    } catch (error) {
      if (!isSqliteBusy(error)) {
        database.close();
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      database.close();
      throw new CliError("Timed out waiting for the CLI config lock.", ExitCode.unavailable);
    }
    await delay(CONFIG_LOCK_RETRY_MS);
  }
}

async function mutateConfig(
  mutation: (config: CliConfig) => CliConfig,
  env: NodeJS.ProcessEnv,
): Promise<CliConfig> {
  const release = await acquireConfigLock(env);
  try {
    const next = mutation(await readConfig(env));
    await writeConfig(next, env);
    return next;
  } finally {
    await release();
  }
}

export async function updateProfile(
  profileName: string,
  update: Partial<ProfileConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  return mutateConfig((config) => {
    const current = profileForName(config, profileName) ?? {
      apiUrl: DEFAULT_API_URL,
      mock: false,
    };
    let profile = { ...current, ...update };
    if (
      update.apiUrl !== undefined &&
      !sameApiOrigin(current.apiUrl, update.apiUrl) &&
      !Object.prototype.hasOwnProperty.call(update, "apiKey")
    ) {
      const {
        apiKey: _apiKey,
        apiKeyExpiresAt: _apiKeyExpiresAt,
        refreshToken: _refreshToken,
        ...withoutCredentials
      } = profile;
      profile = withoutCredentials;
    }
    return {
      version: 1,
      currentProfile: profileName,
      profiles: { ...config.profiles, [profileName]: profile },
    };
  }, env);
}

export async function replaceProfile(
  profileName: string,
  replacement: ProfileConfig | ((current: ProfileConfig) => ProfileConfig),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  return mutateConfig((config) => {
    const current = profileForName(config, profileName) ?? {
      apiUrl: DEFAULT_API_URL,
      mock: false,
    };
    const profile = typeof replacement === "function" ? replacement(current) : replacement;
    let nextProfile = profile;
    if (
      current.apiKey &&
      profile.apiKey === current.apiKey &&
      !sameApiOrigin(current.apiUrl, profile.apiUrl)
    ) {
      const {
        apiKey: _apiKey,
        apiKeyExpiresAt: _apiKeyExpiresAt,
        refreshToken: _refreshToken,
        ...withoutCredentials
      } = profile;
      nextProfile = withoutCredentials;
    }
    return {
      version: 1,
      currentProfile: profileName,
      profiles: { ...config.profiles, [profileName]: nextProfile },
    };
  }, env);
}

export async function removeProfileCredentials(
  profileName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  return mutateConfig((config) => {
    const profile = profileForName(config, profileName);
    if (!profile) {
      throw new CliError(`Unknown CLI profile: ${profileName}`, ExitCode.validation);
    }
    const {
      apiKey: _apiKey,
      apiKeyExpiresAt: _apiKeyExpiresAt,
      credentialState: _credentialState,
      refreshAttemptId: _refreshAttemptId,
      refreshStartedAt: _refreshStartedAt,
      refreshToken: _refreshToken,
      ...withoutCredentials
    } = profile;
    return {
      ...config,
      profiles: { ...config.profiles, [profileName]: withoutCredentials },
    } satisfies CliConfig;
  }, env);
}

export async function clearProfileContext(
  profileName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  return mutateConfig((config) => {
    const profile = profileForName(config, profileName);
    if (!profile) {
      throw new CliError(`Unknown CLI profile: ${profileName}`, ExitCode.validation);
    }
    const {
      organizationId: _organizationId,
      projectId: _projectId,
      environmentId: _environmentId,
      workspaceId: _workspaceId,
      ...withoutContext
    } = profile;
    return {
      ...config,
      currentProfile: profileName,
      profiles: { ...config.profiles, [profileName]: withoutContext },
    } satisfies CliConfig;
  }, env);
}

interface RefreshedDeviceToken {
  readonly bearerToken: string;
  readonly expiresIn: number;
  readonly refreshToken?: string;
}

function parseRefreshedDeviceToken(data: unknown): RefreshedDeviceToken | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { bearerToken, expiresIn, refreshToken, tokenType } = data as Record<string, unknown>;
  if (
    tokenType !== "Bearer" ||
    typeof bearerToken !== "string" ||
    !bearerToken ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 1
  ) {
    return undefined;
  }
  return {
    bearerToken,
    expiresIn,
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
  };
}

/**
 * identity-api accepts the previous refresh token again for 60 s after it rotates, and treats a
 * later reuse as theft. Resending inside this command's deadline, which is shorter than that
 * window, recovers a rotation whose response was lost. A 200 the CLI cannot read counts as lost:
 * the server rotated before answering.
 */
async function exchangeRefreshToken(
  apiUrl: string,
  refreshToken: string,
  deadline: AbortSignal,
  retryDelaysMs: readonly number[] = DEVICE_REFRESH_RETRY_DELAYS_MS,
): Promise<RefreshedDeviceToken> {
  let failure: unknown;
  try {
    const response = await createPlatformSdk({
      baseUrl: apiUrl,
      signal: deadline,
    }).request({
      body: { refreshToken },
      method: "POST",
      path: "/v1/device-authorizations/token",
    });
    const refreshed = parseRefreshedDeviceToken(response.data);
    if (refreshed) return refreshed;
    failure = new CliError(
      "The Deployments.ai API returned an invalid refreshed device token.",
      ExitCode.unavailable,
    );
  } catch (error) {
    const transient =
      error instanceof PlatformTransportError ||
      (error instanceof PlatformApiError && error.problem.status >= 500);
    if (!transient) throw error;
    failure = error;
  }
  const [retryDelayMs, ...remainingDelaysMs] = retryDelaysMs;
  if (retryDelayMs === undefined || deadline.aborted) throw failure;
  await delay(retryDelayMs, undefined, { signal: deadline }).catch(() => {
    throw failure;
  });
  return exchangeRefreshToken(apiUrl, refreshToken, deadline, remainingDelaysMs);
}

async function refreshProfileDeviceCredential(
  profileName: string,
  apiUrl: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new CliError("Device refresh timeout must be a positive integer.", ExitCode.validation);
  }
  const profileHash = createHash("sha256").update(profileName).digest("hex");
  const release = await acquireConfigLock(
    env,
    `refresh-${profileHash}`,
    DEVICE_REFRESH_LOCK_TIMEOUT_MS,
  );
  // Bun cancels an AbortSignal.timeout timer once its last abort listener is removed, which every
  // resend delay does, so the deadline is a plain timer that holds across every request.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      deadline.abort(new DOMException("The device credential refresh timed out.", "TimeoutError")),
    timeoutMs,
  );
  try {
    const config = await readConfig(env);
    const profile = profileForName(config, profileName);
    if (!profile) {
      throw new CliError(`Unknown CLI profile: ${profileName}`, ExitCode.validation);
    }
    const activeApiKey = activeDeviceCredential(profile, apiUrl);
    if (activeApiKey) return activeApiKey;
    if (
      !profile.apiKey ||
      !profile.apiKeyExpiresAt ||
      !profile.refreshToken ||
      !sameApiOrigin(apiUrl, profile.apiUrl)
    ) {
      throw new CliError(
        "The device credential has expired. Run deployments auth login to authenticate again.",
        ExitCode.authentication,
      );
    }
    const expiredCredential = {
      apiKey: profile.apiKey,
      apiKeyExpiresAt: profile.apiKeyExpiresAt,
      refreshToken: profile.refreshToken,
    };
    const refreshToken = expiredCredential.refreshToken;
    let refreshed: RefreshedDeviceToken;
    try {
      refreshed = await exchangeRefreshToken(apiUrl, refreshToken, deadline.signal);
    } catch (error) {
      if (error instanceof PlatformApiError && isDefinitiveRefreshRejection(error.problem.code)) {
        let loggedInApiKey: string | undefined;
        await mutateConfig((latestConfig) => {
          const latestProfile = profileForName(latestConfig, profileName);
          loggedInApiKey = latestProfile && activeDeviceCredential(latestProfile, apiUrl);
          return markReauthenticationRequired(latestConfig, profileName, profile);
        }, env);
        if (loggedInApiKey) return loggedInApiKey;
        throw new CliError(
          "The device credential is no longer active. Run deployments auth login to authenticate again.",
          ExitCode.authentication,
        );
      }
      throw error;
    }
    const refreshedApiKey = refreshed.bearerToken;
    const rotatedRefreshToken = refreshed.refreshToken ?? refreshToken;
    try {
      const identity = await createPlatformSdk({
        apiKey: refreshedApiKey,
        baseUrl: apiUrl,
        signal: deadline.signal,
      }).request({
        method: "GET",
        path: "/v1/whoami",
      });
      const identityId =
        typeof identity.data === "object" && identity.data !== null && "id" in identity.data
          ? identity.data.id
          : undefined;
      if (typeof identityId !== "string" || identityId.trim().length === 0) {
        throw new CliError(
          "The Deployments.ai API returned an invalid identity response.",
          ExitCode.unavailable,
        );
      }
    } catch (error) {
      if (rotatedRefreshToken !== refreshToken) {
        await mutateConfig(
          (latestConfig) =>
            replaceDeviceCredential(latestConfig, profileName, profile, {
              ...expiredCredential,
              refreshToken: rotatedRefreshToken,
            }) ?? latestConfig,
          env,
        );
      }
      throw error;
    }

    let selectedApiKey = refreshedApiKey;
    await mutateConfig((latestConfig) => {
      const refreshedConfig = replaceDeviceCredential(latestConfig, profileName, profile, {
        apiKey: refreshedApiKey,
        apiKeyExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1_000).toISOString(),
        refreshToken: rotatedRefreshToken,
      });
      if (refreshedConfig) return { ...refreshedConfig, currentProfile: profileName };
      const latestProfile = profileForName(latestConfig, profileName);
      const currentApiKey = latestProfile
        ? activeDeviceCredential(latestProfile, apiUrl)
        : undefined;
      if (!currentApiKey) {
        throw new CliError(
          "The CLI profile changed while refreshing its device credential. Retry the command.",
          ExitCode.authentication,
        );
      }
      selectedApiKey = currentApiKey;
      return latestConfig;
    }, env);
    return selectedApiKey;
  } finally {
    clearTimeout(deadlineTimer);
    await release();
  }
}

export async function resolveContext(
  args: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly allowInactiveDeviceCredential?: boolean;
    readonly deviceRefreshTimeoutMs?: number;
    readonly refreshDeviceCredential?: boolean;
  } = {},
): Promise<ResolvedCliContext> {
  const config = await readConfig(env);
  const profileName = resolveProfileName(args, config, env);
  for (const [key, label] of [
    ["DEPLOYMENTS_ORG", "DEPLOYMENTS_ORG"],
    ["DEPLOYMENTS_PROJECT", "DEPLOYMENTS_PROJECT"],
    ["DEPLOYMENTS_ENVIRONMENT", "DEPLOYMENTS_ENVIRONMENT"],
    ["DEPLOYMENTS_WORKSPACE", "DEPLOYMENTS_WORKSPACE"],
    ["DEPLOYMENTS_API_URL", "DEPLOYMENTS_API_URL"],
    ["DEPLOYMENTS_API_KEY", "DEPLOYMENTS_API_KEY"],
  ] as const) {
    if (env[key] !== undefined && optional(env[key]) === undefined) {
      throw new CliError(`${label} must be a non-empty, unpadded value.`, ExitCode.validation);
    }
  }
  for (const [key, label] of [
    ["org", "--org"],
    ["project", "--project"],
    ["env", "--env"],
    ["workspace", "--workspace"],
  ] as const) {
    if (args[key] !== undefined && optional(args[key]) === undefined) {
      throw new CliError(`${label} must be a non-empty, unpadded value.`, ExitCode.validation);
    }
  }
  for (const [key, label] of [
    ["apiUrl", "--api-url"],
    ["apiKey", "--api-key"],
  ] as const) {
    if (args[key] !== undefined && optional(args[key]) === undefined) {
      throw new CliError(`${label} must be a non-empty, unpadded value.`, ExitCode.validation);
    }
  }
  const profile = profileForName(config, profileName) ?? {
    apiUrl: DEFAULT_API_URL,
    mock: false,
  };
  if (args.mock === true && args.live === true) {
    throw new CliError("Choose either --mock or --live, not both.", ExitCode.usage);
  }
  const explicitMode = args.mock === true ? true : args.live === true ? false : undefined;
  if (explicitMode === undefined && env.DEPLOYMENTS_MOCK === "1" && env.DEPLOYMENTS_LIVE === "1") {
    throw new CliError(
      "Choose either DEPLOYMENTS_MOCK=1 or DEPLOYMENTS_LIVE=1, not both.",
      ExitCode.usage,
    );
  }
  const environmentMode =
    env.DEPLOYMENTS_MOCK === "1" ? true : env.DEPLOYMENTS_LIVE === "1" ? false : undefined;
  const mock = explicitMode ?? environmentMode ?? profile.mock ?? false;
  const organization = scopedValue(args.org, env.DEPLOYMENTS_ORG, profile.organizationId);
  const projectCandidate = scopedValue(args.project, env.DEPLOYMENTS_PROJECT, profile.projectId);
  const project =
    projectCandidate.precedence >= organization.precedence ? projectCandidate : { precedence: 0 };
  const environmentCandidate = scopedValue(
    args.env,
    env.DEPLOYMENTS_ENVIRONMENT,
    profile.environmentId,
  );
  const environment =
    environmentCandidate.precedence >= Math.max(organization.precedence, project.precedence)
      ? environmentCandidate
      : { precedence: 0 };
  const workspaceCandidate = scopedValue(
    args.workspace,
    env.DEPLOYMENTS_WORKSPACE,
    profile.workspaceId,
  );
  const workspace =
    workspaceCandidate.precedence >=
    Math.max(organization.precedence, project.precedence, environment.precedence)
      ? workspaceCandidate
      : { precedence: 0 };
  const apiUrlValue = scopedValue(args.apiUrl, env.DEPLOYMENTS_API_URL, profile.apiUrl);
  const apiUrl = apiUrlValue.value ?? profile.apiUrl;
  validateApiUrl(apiUrl);
  const explicitApiKey = optional(args.apiKey);
  const environmentApiKey = optional(env.DEPLOYMENTS_API_KEY);
  const selectedEnvironmentApiKey = apiUrlValue.precedence <= 2 ? environmentApiKey : undefined;
  let resolvedApiKey =
    explicitApiKey ??
    selectedEnvironmentApiKey ??
    (profile.apiKey && sameApiOrigin(apiUrl, profile.apiUrl) ? profile.apiKey : undefined);
  const profileCredentialSelected =
    !explicitApiKey &&
    !selectedEnvironmentApiKey &&
    resolvedApiKey === profile.apiKey &&
    sameApiOrigin(apiUrl, profile.apiUrl);
  if (
    !mock &&
    profileCredentialSelected &&
    profile.credentialState &&
    profile.credentialState !== "active"
  ) {
    if (
      profile.credentialState === "refresh-in-progress" &&
      options.refreshDeviceCredential === true
    ) {
      resolvedApiKey = await refreshProfileDeviceCredential(
        profileName,
        apiUrl,
        env,
        options.deviceRefreshTimeoutMs ?? DEVICE_REFRESH_TIMEOUT_MS,
      );
    } else if (options.allowInactiveDeviceCredential !== true) {
      throw new CliError(
        "The device credential is not active. Run deployments auth login to authenticate again.",
        ExitCode.authentication,
      );
    }
  }
  const deviceCredentialExpiring =
    !mock &&
    profileCredentialSelected &&
    profile.apiKeyExpiresAt &&
    Date.parse(profile.apiKeyExpiresAt) <= Date.now() + 60_000;
  if (deviceCredentialExpiring && options.refreshDeviceCredential !== true) {
    resolvedApiKey = undefined;
  } else if (deviceCredentialExpiring) {
    resolvedApiKey = await refreshProfileDeviceCredential(
      profileName,
      apiUrl,
      env,
      options.deviceRefreshTimeoutMs ?? DEVICE_REFRESH_TIMEOUT_MS,
    );
  }
  return {
    profileName,
    apiUrl,
    ...(resolvedApiKey && (mock || resolvedApiKey !== MOCK_SESSION_API_KEY)
      ? { apiKey: resolvedApiKey }
      : {}),
    ...(organization.value ? { organizationId: organization.value } : {}),
    ...(project.value ? { projectId: project.value } : {}),
    ...(environment.value ? { environmentId: environment.value } : {}),
    ...(workspace.value ? { workspaceId: workspace.value } : {}),
    mock,
  };
}
