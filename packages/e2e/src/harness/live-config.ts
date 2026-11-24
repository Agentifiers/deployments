import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { E2eConfigurationError } from "./errors.ts";
import { fetchResendingGatewayThrottles } from "./http-client.ts";
import {
  captureCookies,
  cookieHeader,
  deviceAuthorizedPlatformToken,
  type IdentityPasswordCredentials,
  issuedPlatformToken,
  responseJson,
} from "./identity-device-token.ts";
import {
  type IssuedPlatformToken,
  type PlatformCredential,
  refreshingPlatformCredential,
  staticPlatformCredential,
} from "./platform-credential.ts";

export function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export interface PublicE2eConfig {
  readonly apiUrl: string;
  /** Stream gateway origin; gateway-served operations are probed only when it is set. */
  readonly streamGatewayUrl?: string;
}

export interface CredentialedE2eConfig extends PublicE2eConfig {
  readonly agentEmailDomain?: string;
  readonly awsRegion?: string;
  readonly environmentId?: string;
  readonly callbackInitialSecret?: string;
  readonly callbackRotatedSecret?: string;
  readonly mcpInitialToken?: string;
  readonly mcpRotatedToken?: string;
  readonly organizationId: string;
  /** Short-lived platform JWT (or a configured static key); read `.token` per request. */
  readonly platformCredential: PlatformCredential;
  readonly privilegedPlatformCredential?: PlatformCredential;
  readonly projectId?: string;
  readonly webhookUrl?: string;
}

export interface ScopedE2eConfig extends CredentialedE2eConfig {
  readonly environmentId: string;
  readonly projectId: string;
}

export interface FeatureE2eConfig extends ScopedE2eConfig {
  readonly webhookUrl: string;
}

export interface AgentEmailE2eConfig extends ScopedE2eConfig {
  readonly agentEmailDomain: string;
  readonly awsRegion: string;
}

export interface McpE2eConfig extends ScopedE2eConfig {
  readonly mcpInitialToken: string;
  readonly mcpRotatedToken: string;
}

export interface CallbackE2eConfig extends ScopedE2eConfig {
  readonly callbackInitialSecret: string;
  readonly callbackRotatedSecret: string;
}

export interface ChannelApiE2eConfig extends ScopedE2eConfig {
  readonly channelApiUrl: string;
}

/** Platform API origin under test; live suites never assume a default deployment. */
export function e2eApiUrl(): string {
  const apiUrl = optional("DEPLOYMENTS_E2E_API_URL");
  if (!apiUrl) {
    throw new E2eConfigurationError({
      message: "Set DEPLOYMENTS_E2E_API_URL to the platform API origin under test.",
    });
  }
  return apiUrl;
}

function channelApiTargetIsApproved(apiUrl: string): boolean {
  try {
    const target = new URL(apiUrl);
    return (
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      target.port === "" &&
      target.pathname === "/" &&
      !target.search &&
      !target.hash &&
      /^[a-z0-9]+\.execute-api\.us-east-2\.amazonaws\.com$/u.test(target.hostname) &&
      optional("DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL") === apiUrl
    );
  } catch {
    return false;
  }
}

export function publicE2eConfig(): PublicE2eConfig {
  const streamGatewayUrl = optional("DEPLOYMENTS_E2E_STREAM_GATEWAY_URL");
  return {
    apiUrl: e2eApiUrl(),
    ...(streamGatewayUrl ? { streamGatewayUrl } : {}),
  };
}

function jwtSegment(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function safeJwtMetadata(token: string) {
  const [encodedHeader, encodedClaims, signature, ...remainder] = token.split(".");
  if (!encodedHeader || !encodedClaims || !signature || remainder.length > 0) return "non-jwt";
  const header = jwtSegment(encodedHeader);
  const claims = jwtSegment(encodedClaims);
  if (!header || !claims) return "malformed-jwt";
  return JSON.stringify({
    alg: header.alg,
    aud: claims.aud,
    client_id: claims.client_id,
    exp: claims.exp,
    iat: claims.iat,
    iss: claims.iss,
    kid: header.kid,
    nbf: claims.nbf,
    typ: header.typ,
  });
}

function identityAccessToken(
  apiUrl: string,
  credentials: IdentityPasswordCredentials,
): Effect.Effect<IssuedPlatformToken, E2eConfigurationError> {
  return Effect.tryPromise({
    try: () => deviceAuthorizedPlatformToken(apiUrl, credentials),
    catch: (cause) =>
      new E2eConfigurationError({
        cause,
        message: "Unable to mint the credentialed E2E platform access token.",
      }),
  });
}

export function privilegedIdentityAccessToken(
  credentials: IdentityPasswordCredentials & {
    readonly clientSecret: string;
    readonly redirectUri: string;
  },
): Effect.Effect<IssuedPlatformToken, E2eConfigurationError> {
  return Effect.tryPromise({
    try: async () => {
      const issuer = new URL(credentials.issuer);
      const redirectUri = new URL(credentials.redirectUri);
      const cookies = new Map<string, string>();
      const ui = await fetchResendingGatewayThrottles(new URL("/sign-in", issuer), {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!ui.ok) throw new Error(`Identity sign-in page returned HTTP ${ui.status}.`);
      captureCookies(cookies, ui);
      const csrfEntry = [...cookies].find(([name]) => name.endsWith("dpl_csrf"));
      if (!csrfEntry?.[1]) throw new Error("Identity sign-in page did not set a CSRF cookie.");
      const signIn = await fetchResendingGatewayThrottles(new URL("/v1/auth/sign-in", issuer), {
        body: JSON.stringify({ email: credentials.username, password: credentials.password }),
        headers: {
          cookie: cookieHeader(cookies),
          "content-type": "application/json",
          origin: issuer.origin,
          "x-csrf-token": csrfEntry[1],
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      captureCookies(cookies, signIn);
      await responseJson(signIn, "Privileged identity sign-in");

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(24).toString("base64url");
      const authorization = new URL("/oauth2/authorize", issuer);
      authorization.search = new URLSearchParams({
        client_id: "deployments-e2e",
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: randomBytes(24).toString("base64url"),
        redirect_uri: redirectUri.toString(),
        response_type: "code",
        scope: "openid managed-skills:admin managed-skills:read memory:execute",
        state,
      }).toString();
      const authorized = await fetchResendingGatewayThrottles(authorization, {
        headers: { cookie: cookieHeader(cookies) },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const location = authorized.headers.get("location");
      if (authorized.status < 300 || authorized.status >= 400 || !location) {
        throw new Error(`Privileged authorization returned HTTP ${authorized.status}.`);
      }
      const continuation = new URL(location, issuer);
      if (
        continuation.origin !== redirectUri.origin ||
        continuation.pathname !== redirectUri.pathname
      ) {
        throw new Error("Privileged authorization returned an unexpected redirect URI.");
      }
      if (continuation.searchParams.get("state") !== state) {
        throw new Error("Privileged authorization returned an invalid state value.");
      }
      const code = continuation.searchParams.get("code");
      if (!code) throw new Error("Privileged authorization returned no authorization code.");

      const token = await responseJson(
        await fetchResendingGatewayThrottles(new URL("/oauth2/token", issuer), {
          body: new URLSearchParams({
            client_id: "deployments-e2e",
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri.toString(),
          }),
          headers: {
            authorization: `Basic ${Buffer.from(`deployments-e2e:${credentials.clientSecret}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }),
        "Privileged identity token exchange",
      );
      if (typeof token.access_token !== "string" || !token.access_token) {
        throw new Error("Privileged identity token exchange returned no access token.");
      }
      return issuedPlatformToken(
        token.access_token,
        token.expires_in,
        "Privileged identity token exchange",
      );
    },
    catch: (cause) =>
      new E2eConfigurationError({
        cause,
        message: "Unable to mint the privileged E2E platform access token.",
      }),
  });
}

export const credentialedE2eConfig = Effect.gen(function* () {
  const apiUrl = optional("DEPLOYMENTS_E2E_API_URL");
  const agentEmailDomain = optional("DEPLOYMENTS_E2E_AGENT_EMAIL_DOMAIN");
  const awsRegion = optional("DEPLOYMENTS_E2E_AWS_REGION") ?? optional("AWS_REGION");
  const organizationId = optional("DEPLOYMENTS_E2E_ORGANIZATION_ID");
  const apiKeyFile = optional("DEPLOYMENTS_E2E_PLATFORM_API_KEY_FILE");
  const directPlatformApiKey =
    optional("DEPLOYMENTS_E2E_PLATFORM_API_KEY") ??
    (apiKeyFile
      ? yield* Effect.tryPromise({
          try: async () => (await readFile(apiKeyFile, "utf8")).trim(),
          catch: () =>
            new E2eConfigurationError({
              message: "Unable to read DEPLOYMENTS_E2E_PLATFORM_API_KEY_FILE.",
            }),
        })
      : undefined);
  const identity = {
    clientSecret: optional("DEPLOYMENTS_E2E_IDENTITY_CLIENT_SECRET"),
    issuer: optional("DEPLOYMENTS_E2E_IDENTITY_ISSUER"),
    password: optional("DEPLOYMENTS_E2E_IDENTITY_PASSWORD"),
    redirectUri: optional("DEPLOYMENTS_E2E_IDENTITY_REDIRECT_URI"),
    username: optional("DEPLOYMENTS_E2E_IDENTITY_USERNAME"),
  };
  const environmentId = optional("DEPLOYMENTS_E2E_ENVIRONMENT_ID");
  const callbackInitialSecret = optional("DEPLOYMENTS_E2E_CALLBACK_INITIAL_SECRET");
  const callbackRotatedSecret = optional("DEPLOYMENTS_E2E_CALLBACK_ROTATED_SECRET");
  const mcpInitialToken = optional("DEPLOYMENTS_E2E_MCP_INITIAL_TOKEN");
  const mcpRotatedToken = optional("DEPLOYMENTS_E2E_MCP_ROTATED_TOKEN");
  const projectId = optional("DEPLOYMENTS_E2E_PROJECT_ID");
  const webhookUrl = optional("DEPLOYMENTS_E2E_WEBHOOK_URL");
  const missing = [
    ["DEPLOYMENTS_E2E_API_URL", apiUrl],
    ["DEPLOYMENTS_E2E_ORGANIZATION_ID", organizationId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    return yield* new E2eConfigurationError({
      message: `Missing credentialed E2E configuration: ${missing.join(", ")}.`,
    });
  }
  if (optional("DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE") !== apiUrl) {
    return yield* new E2eConfigurationError({
      message:
        "Credentialed E2E is destructive. To acknowledge the target, set DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE to the exact DEPLOYMENTS_E2E_API_URL value.",
    });
  }
  const identityCredentials =
    identity.issuer && identity.password && identity.username
      ? { issuer: identity.issuer, password: identity.password, username: identity.username }
      : undefined;
  const platformCredential = directPlatformApiKey
    ? staticPlatformCredential(directPlatformApiKey)
    : identityCredentials
      ? yield* refreshingPlatformCredential(identityAccessToken(apiUrl!, identityCredentials))
      : undefined;
  if (!platformCredential) {
    return yield* new E2eConfigurationError({
      message:
        "Configure DEPLOYMENTS_E2E_PLATFORM_API_KEY or the platform identity issuer, username, and password.",
    });
  }
  const privilegedPlatformCredential =
    identityCredentials && identity.clientSecret && identity.redirectUri
      ? yield* refreshingPlatformCredential(
          privilegedIdentityAccessToken({
            ...identityCredentials,
            clientSecret: identity.clientSecret,
            redirectUri: identity.redirectUri,
          }),
        )
      : undefined;
  return {
    apiUrl: apiUrl!,
    ...(agentEmailDomain ? { agentEmailDomain } : {}),
    ...(awsRegion ? { awsRegion } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(callbackInitialSecret ? { callbackInitialSecret } : {}),
    ...(callbackRotatedSecret ? { callbackRotatedSecret } : {}),
    ...(mcpInitialToken ? { mcpInitialToken } : {}),
    ...(mcpRotatedToken ? { mcpRotatedToken } : {}),
    organizationId: organizationId!,
    platformCredential,
    ...(privilegedPlatformCredential ? { privilegedPlatformCredential } : {}),
    ...(projectId ? { projectId } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
  };
});

export const scopedE2eConfig = credentialedE2eConfig.pipe(
  Effect.flatMap((config) => {
    if (!config.environmentId || !config.projectId) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "Scoped E2E requires DEPLOYMENTS_E2E_PROJECT_ID and DEPLOYMENTS_E2E_ENVIRONMENT_ID.",
        }),
      );
    }
    return Effect.succeed(config as ScopedE2eConfig);
  }),
);

export const featureE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) =>
    config.webhookUrl
      ? Effect.succeed(config as FeatureE2eConfig)
      : Effect.fail(
          new E2eConfigurationError({
            message: "Feature E2E requires DEPLOYMENTS_E2E_WEBHOOK_URL.",
          }),
        ),
  ),
);

export const agentEmailE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) =>
    config.agentEmailDomain && config.awsRegion
      ? Effect.succeed(config as AgentEmailE2eConfig)
      : Effect.fail(
          new E2eConfigurationError({
            message:
              "Agent Email E2E requires DEPLOYMENTS_E2E_AGENT_EMAIL_DOMAIN and an AWS region.",
          }),
        ),
  ),
);

export const mcpE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) =>
    config.mcpInitialToken &&
    config.mcpRotatedToken &&
    config.mcpInitialToken !== config.mcpRotatedToken
      ? Effect.succeed(config as McpE2eConfig)
      : Effect.fail(
          new E2eConfigurationError({
            message:
              "MCP E2E requires distinct DEPLOYMENTS_E2E_MCP_INITIAL_TOKEN and DEPLOYMENTS_E2E_MCP_ROTATED_TOKEN values.",
          }),
        ),
  ),
);

export const callbackE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) =>
    config.callbackInitialSecret &&
    config.callbackRotatedSecret &&
    config.callbackInitialSecret !== config.callbackRotatedSecret
      ? Effect.succeed(config as CallbackE2eConfig)
      : Effect.fail(
          new E2eConfigurationError({
            message:
              "HTTP callback E2E requires distinct DEPLOYMENTS_E2E_CALLBACK_INITIAL_SECRET and DEPLOYMENTS_E2E_CALLBACK_ROTATED_SECRET values.",
          }),
        ),
  ),
);

export const channelApiE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) => {
    const channelApiUrl = optional("DEPLOYMENTS_E2E_CHANNEL_API_URL");
    if (!channelApiUrl) {
      return Effect.fail(
        new E2eConfigurationError({
          message: "Channel provider E2E requires DEPLOYMENTS_E2E_CHANNEL_API_URL.",
        }),
      );
    }
    if (!channelApiTargetIsApproved(channelApiUrl)) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "Channel provider E2E requires a credential-free HTTPS API Gateway origin in us-east-2. Set DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL to the exact DEPLOYMENTS_E2E_CHANNEL_API_URL value after confirming it is the development channel_provider_api_endpoint OpenTofu output.",
        }),
      );
    }
    return Effect.succeed({ ...config, channelApiUrl } satisfies ChannelApiE2eConfig);
  }),
);

export const slackIdentityE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) => {
    const required = {
      DEPLOYMENTS_E2E_CHANNEL_API_URL: optional("DEPLOYMENTS_E2E_CHANNEL_API_URL"),
      DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME: optional("DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME"),
      DEPLOYMENTS_E2E_SLACK_BOT_TOKEN: optional("DEPLOYMENTS_E2E_SLACK_BOT_TOKEN"),
      DEPLOYMENTS_E2E_SLACK_CHANNEL_ID: optional("DEPLOYMENTS_E2E_SLACK_CHANNEL_ID"),
      DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET: optional("DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET"),
      DEPLOYMENTS_E2E_SLACK_TEAM_ID: optional("DEPLOYMENTS_E2E_SLACK_TEAM_ID"),
      DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID: optional("DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID"),
      DEPLOYMENTS_E2E_SLACK_USER_ID: optional("DEPLOYMENTS_E2E_SLACK_USER_ID"),
      DEPLOYMENTS_E2E_SLACK_USER_TOKEN: optional("DEPLOYMENTS_E2E_SLACK_USER_TOKEN"),
    };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (
      missing.length === 0 &&
      !channelApiTargetIsApproved(required.DEPLOYMENTS_E2E_CHANNEL_API_URL!)
    ) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "Slack identity E2E requires a credential-free HTTPS API Gateway origin in us-east-2. Set DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL to the exact DEPLOYMENTS_E2E_CHANNEL_API_URL value after confirming it is the development channel_provider_api_endpoint OpenTofu output.",
        }),
      );
    }
    if (
      missing.length === 0 &&
      (!required.DEPLOYMENTS_E2E_SLACK_BOT_TOKEN!.startsWith("xoxb-") ||
        !required.DEPLOYMENTS_E2E_SLACK_USER_TOKEN!.startsWith("xoxp-") ||
        required.DEPLOYMENTS_E2E_SLACK_USER_TOKEN === required.DEPLOYMENTS_E2E_SLACK_BOT_TOKEN)
    ) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "Slack identity E2E requires distinct xoxb bot and xoxp user tokens for user-group management and public-channel reply observation.",
        }),
      );
    }
    return missing.length === 0
      ? Effect.succeed({
          ...config,
          slackAgentUsername: required.DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME!,
          slackBotToken: required.DEPLOYMENTS_E2E_SLACK_BOT_TOKEN!,
          slackChannelApiUrl: required.DEPLOYMENTS_E2E_CHANNEL_API_URL!,
          slackChannelId: required.DEPLOYMENTS_E2E_SLACK_CHANNEL_ID!,
          slackSigningSecret: required.DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET!,
          slackTeamId: required.DEPLOYMENTS_E2E_SLACK_TEAM_ID!,
          slackUserGroupId: required.DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID!,
          slackUserId: required.DEPLOYMENTS_E2E_SLACK_USER_ID!,
          slackUserToken: required.DEPLOYMENTS_E2E_SLACK_USER_TOKEN!,
        })
      : Effect.fail(
          new E2eConfigurationError({
            message: `Slack identity E2E is enabled but missing configuration: ${missing.join(", ")}.`,
          }),
        );
  }),
);

export function credentialedE2eEnabled(): boolean {
  return process.env.DEPLOYMENTS_E2E_LIVE?.trim().toLowerCase() === "true";
}

export function slackIdentityE2eEnabled(): boolean {
  return process.env.DEPLOYMENTS_E2E_SLACK_LIVE?.trim().toLowerCase() === "true";
}
