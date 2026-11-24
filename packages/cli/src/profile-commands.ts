import { defineCommand, type ArgsDef } from "citty";
import { PlatformApiError } from "@agentifiers/deployments-sdk";
import {
  clearProfileContext,
  MOCK_SESSION_API_KEY,
  profileForName,
  readConfig,
  replaceProfile,
  removeProfileCredentials,
  resolveContext,
  resolveProfileName,
} from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { renderOutput, sanitizeTerminalText } from "./output.ts";
import type { ProfileConfig } from "./types.ts";
import type { CliRuntime, AnyCommand } from "./command-runtime.ts";
import { colorEnabled, commonArgs, readSecretFile, sdkFor } from "./command-runtime.ts";
const LOGIN_REQUEST_TIMEOUT_MS = 30_000;
const authArgs = {
  profile: commonArgs.profile,
  "api-url": commonArgs["api-url"],
  "api-key": commonArgs["api-key"],
  "api-key-file": {
    type: "string",
    description: "File containing the bearer token",
    valueHint: "path",
  },
  live: commonArgs.live,
  mock: commonArgs.mock,
  json: commonArgs.json,
  quiet: commonArgs.quiet,
  color: commonArgs.color,
} as const satisfies ArgsDef;

export function devicePollingDelayMilliseconds(
  expiresAt: number,
  intervalMilliseconds: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(intervalMilliseconds, expiresAt - now));
}

async function deviceLogin(
  runtime: CliRuntime,
  context: Awaited<ReturnType<typeof resolveContext>>,
): Promise<{
  readonly apiKey: string;
  readonly apiKeyExpiresAt: string;
  readonly refreshToken?: string;
}> {
  const started = await sdkFor(context, {
    signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
  }).request<{
    deviceCode?: unknown;
    expiresIn?: unknown;
    interval?: unknown;
    userCode?: unknown;
    verificationUri?: unknown;
    verificationUriComplete?: unknown;
  }>({
    body: { clientId: "deployments-cli" },
    method: "POST",
    path: "/v1/device-authorizations",
  });
  const device = started.data;
  if (
    typeof device.deviceCode !== "string" ||
    typeof device.userCode !== "string" ||
    typeof device.verificationUri !== "string" ||
    !Number.isSafeInteger(device.expiresIn) ||
    Number(device.expiresIn) < 1 ||
    !Number.isSafeInteger(device.interval) ||
    Number(device.interval) < 1
  ) {
    throw new CliError(
      "The Deployments.ai API returned an invalid device authorization response.",
      ExitCode.unavailable,
    );
  }
  const verificationUri =
    typeof device.verificationUriComplete === "string"
      ? device.verificationUriComplete
      : device.verificationUri;
  runtime.io.stderr(
    `Open ${sanitizeTerminalText(verificationUri)} and enter code ${sanitizeTerminalText(device.userCode)}.`,
  );
  const expiresAt = Date.now() + Number(device.expiresIn) * 1_000;
  const sdk = sdkFor(context, {
    signal: AbortSignal.timeout(Number(device.expiresIn) * 1_000),
  });
  let intervalMilliseconds = Number(device.interval) * 1_000;
  while (Date.now() < expiresAt) {
    const delayMilliseconds = devicePollingDelayMilliseconds(expiresAt, intervalMilliseconds);
    if (delayMilliseconds === 0) break;
    await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    if (Date.now() >= expiresAt) break;
    try {
      const exchanged = await sdk.request<{
        bearerToken?: unknown;
        expiresIn?: unknown;
        refreshToken?: unknown;
        tokenType?: unknown;
      }>({
        body: { deviceCode: device.deviceCode },
        method: "POST",
        path: "/v1/device-authorizations/token",
      });
      if (
        exchanged.data.tokenType !== "Bearer" ||
        typeof exchanged.data.bearerToken !== "string" ||
        !exchanged.data.bearerToken ||
        !Number.isSafeInteger(exchanged.data.expiresIn) ||
        Number(exchanged.data.expiresIn) < 1
      ) {
        throw new CliError(
          "The Deployments.ai API returned an invalid device token response.",
          ExitCode.unavailable,
        );
      }
      return {
        apiKey: exchanged.data.bearerToken,
        apiKeyExpiresAt: new Date(
          Date.now() + Number(exchanged.data.expiresIn) * 1_000,
        ).toISOString(),
        ...(typeof exchanged.data.refreshToken === "string" && exchanged.data.refreshToken
          ? { refreshToken: exchanged.data.refreshToken }
          : {}),
      };
    } catch (error) {
      const code = error instanceof PlatformApiError ? error.problem.code : undefined;
      if (code !== "authorization_pending" && code !== "slow_down") throw error;
      if (code === "slow_down") intervalMilliseconds += 5_000;
    }
  }
  throw new CliError(
    "Device authorization expired before it was approved.",
    ExitCode.authentication,
  );
}

export function authCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: { description: "Authentication profiles" },
    subCommands: {
      login: defineCommand({
        meta: { description: "Log in with a browser session or bearer token" },
        args: authArgs,
        async run({ args }) {
          const config = await readConfig(runtime.env);
          const profileName = resolveProfileName(args, config, runtime.env);
          const existingProfile = profileForName(config, profileName);
          if (typeof args.apiKey === "string" && typeof args.apiKeyFile === "string") {
            throw new CliError("Choose either --api-key or --api-key-file.", ExitCode.usage);
          }
          const suppliedApiKey =
            typeof args.apiKey === "string"
              ? args.apiKey
              : typeof args.apiKeyFile === "string"
                ? await readSecretFile(args.apiKeyFile)
                : undefined;
          const selectedContext = await resolveContext(
            {
              ...args,
              profile: profileName,
              ...(suppliedApiKey ? { apiKey: suppliedApiKey } : {}),
            },
            runtime.env,
            { allowInactiveDeviceCredential: true, refreshDeviceCredential: false },
          );
          let apiKey =
            selectedContext.apiKey === MOCK_SESSION_API_KEY ? undefined : selectedContext.apiKey;
          let deviceCredential:
            | {
                readonly apiKey: string;
                readonly apiKeyExpiresAt: string;
                readonly refreshToken?: string;
              }
            | undefined;
          if (!selectedContext.mock && !apiKey) {
            if (!runtime.io.isInteractive || args.json === true) {
              throw new CliError(
                "Interactive device login requires a terminal. Provide --api-key or --api-key-file for non-interactive use.",
                ExitCode.unavailable,
              );
            }
            deviceCredential = await deviceLogin(runtime, selectedContext);
            apiKey = deviceCredential.apiKey;
          }
          if (!selectedContext.mock && apiKey) {
            const identity = await sdkFor(
              { ...selectedContext, apiKey },
              { signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS) },
            ).request({
              method: "GET",
              path: "/v1/whoami",
            });
            if (
              typeof identity.data !== "object" ||
              identity.data === null ||
              typeof (identity.data as { id?: unknown }).id !== "string" ||
              (identity.data as { id: string }).id.trim().length === 0
            ) {
              throw new CliError(
                "The Deployments.ai API returned an invalid identity response.",
                ExitCode.unavailable,
              );
            }
          }
          const update: Partial<ProfileConfig> = {
            apiUrl: selectedContext.apiUrl,
            mock: selectedContext.mock,
            ...(apiKey
              ? { apiKey }
              : selectedContext.mock && !existingProfile?.apiKey
                ? { apiKey: MOCK_SESSION_API_KEY }
                : {}),
          };
          await replaceProfile(
            profileName,
            (current) => {
              const credentialReplaced =
                deviceCredential !== undefined ||
                (update.apiKey !== undefined && update.apiKey !== current.apiKey);
              if (!credentialReplaced) return { ...current, ...update };
              const {
                apiKeyExpiresAt: _apiKeyExpiresAt,
                credentialState: _credentialState,
                refreshAttemptId: _refreshAttemptId,
                refreshStartedAt: _refreshStartedAt,
                refreshToken: _refreshToken,
                ...withoutDeviceCredential
              } = current;
              return {
                ...withoutDeviceCredential,
                ...update,
                ...(deviceCredential
                  ? {
                      apiKeyExpiresAt: deviceCredential.apiKeyExpiresAt,
                      ...(deviceCredential.refreshToken
                        ? { refreshToken: deviceCredential.refreshToken }
                        : {}),
                    }
                  : {}),
              };
            },
            runtime.env,
          );
          renderOutput({
            data: {
              status: "authenticated",
              profile: profileName,
              mode: selectedContext.mock ? "mock" : "live",
            },
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: false,
            kind: "action",
          });
        },
      }),
      logout: defineCommand({
        meta: { description: "Remove credentials from a profile" },
        args: {
          profile: commonArgs.profile,
          json: commonArgs.json,
          quiet: commonArgs.quiet,
          color: commonArgs.color,
        },
        async run({ args }) {
          const config = await readConfig(runtime.env);
          const profileName = resolveProfileName(args, config, runtime.env);
          const profile = profileForName(config, profileName);
          await removeProfileCredentials(profileName, runtime.env);
          if (profile && !profile.mock && profile.refreshToken) {
            try {
              const response = await sdkFor(
                {
                  apiUrl: profile.apiUrl,
                  ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
                  ...(profile.environmentId ? { environmentId: profile.environmentId } : {}),
                  mock: false,
                  ...(profile.organizationId ? { organizationId: profile.organizationId } : {}),
                  profileName,
                  ...(profile.projectId ? { projectId: profile.projectId } : {}),
                  ...(profile.workspaceId ? { workspaceId: profile.workspaceId } : {}),
                },
                { signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS) },
              ).request<{ revoked?: unknown }>({
                body: { refreshToken: profile.refreshToken },
                method: "POST",
                path: "/v1/device-authorizations/revoke",
              });
              if (response.data.revoked !== true) {
                throw new Error("The API returned an invalid logout response.");
              }
            } catch {
              throw new CliError(
                "Local credentials were removed, but server-side revocation failed; the remote session may remain active.",
                ExitCode.unavailable,
              );
            }
          }
          renderOutput({
            data: { status: "logged_out", profile: profileName },
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: false,
            kind: "action",
          });
        },
      }),
    },
  });
}

export function contextCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: { description: "Persistent organization, project, environment, and workspace context" },
    subCommands: {
      show: defineCommand({
        meta: { description: "Show the active CLI context" },
        args: {
          profile: commonArgs.profile,
          json: commonArgs.json,
          quiet: commonArgs.quiet,
          color: commonArgs.color,
        },
        async run({ args }) {
          const context = await resolveContext(args, runtime.env);
          renderOutput({
            data: context,
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: false,
            kind: "detail",
          });
        },
      }),
      set: defineCommand({
        meta: { description: "Set persistent CLI context" },
        args: {
          profile: commonArgs.profile,
          "api-url": commonArgs["api-url"],
          org: commonArgs.org,
          project: commonArgs.project,
          env: commonArgs.env,
          workspace: commonArgs.workspace,
          live: commonArgs.live,
          mock: commonArgs.mock,
          json: commonArgs.json,
          quiet: commonArgs.quiet,
          color: commonArgs.color,
        },
        async run({ args }) {
          const config = await readConfig(runtime.env);
          const profileName = resolveProfileName(args, config, runtime.env);
          if (args.mock === true && args.live === true) {
            throw new CliError("Choose either --mock or --live, not both.", ExitCode.usage);
          }
          const selectedContext = await resolveContext(
            { ...args, profile: profileName },
            runtime.env,
          );
          const inheritedOrganizationId =
            typeof args.org !== "string" &&
            (typeof args.project === "string" ||
              typeof args.env === "string" ||
              typeof args.workspace === "string")
              ? selectedContext.organizationId
              : undefined;
          const inheritedProjectId =
            typeof args.project !== "string" &&
            (typeof args.env === "string" || typeof args.workspace === "string")
              ? selectedContext.projectId
              : undefined;
          const inheritedEnvironmentId =
            typeof args.env !== "string" && typeof args.workspace === "string"
              ? selectedContext.environmentId
              : undefined;
          await replaceProfile(
            profileName,
            (current) => {
              let profile = current;
              if (typeof args.apiUrl === "string") profile = { ...profile, apiUrl: args.apiUrl };
              const organizationId =
                typeof args.org === "string" ? args.org : inheritedOrganizationId;
              if (organizationId) {
                if (organizationId === profile.organizationId) {
                  profile = { ...profile, organizationId };
                } else {
                  const {
                    projectId: _projectId,
                    environmentId: _environmentId,
                    workspaceId: _workspaceId,
                    ...parent
                  } = profile;
                  profile = { ...parent, organizationId };
                }
              }
              const projectId =
                typeof args.project === "string" ? args.project : inheritedProjectId;
              if (projectId) {
                if (projectId === profile.projectId) {
                  profile = { ...profile, projectId };
                } else {
                  const {
                    environmentId: _environmentId,
                    workspaceId: _workspaceId,
                    ...parent
                  } = profile;
                  profile = { ...parent, projectId };
                }
              }
              const environmentId =
                typeof args.env === "string" ? args.env : inheritedEnvironmentId;
              if (environmentId) {
                if (environmentId === profile.environmentId) {
                  profile = { ...profile, environmentId };
                } else {
                  const { workspaceId: _workspaceId, ...parent } = profile;
                  profile = { ...parent, environmentId };
                }
              }
              if (typeof args.workspace === "string")
                profile = { ...profile, workspaceId: args.workspace };
              if (args.live === true) profile = { ...profile, mock: false };
              if (args.mock === true) profile = { ...profile, mock: true };
              if (profile.mock === false && profile.apiKey === MOCK_SESSION_API_KEY) {
                const { apiKey: _apiKey, ...withoutMockCredential } = profile;
                profile = withoutMockCredential;
              }
              return profile;
            },
            runtime.env,
          );
          const context = await resolveContext({ profile: profileName }, runtime.env);
          renderOutput({
            data: context,
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: false,
            kind: "detail",
          });
        },
      }),
      clear: defineCommand({
        meta: { description: "Clear persistent resource context" },
        args: {
          profile: commonArgs.profile,
          json: commonArgs.json,
          quiet: commonArgs.quiet,
          color: commonArgs.color,
        },
        async run({ args }) {
          const config = await readConfig(runtime.env);
          const profileName = resolveProfileName(args, config, runtime.env);
          await clearProfileContext(profileName, runtime.env);
          renderOutput({
            data: { status: "cleared", profile: profileName },
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: false,
            kind: "action",
          });
        },
      }),
    },
  });
}
