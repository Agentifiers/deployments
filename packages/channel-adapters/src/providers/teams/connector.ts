import { createHash } from "node:crypto";

import {
  ChannelAttachmentDownloadError,
  downloadFromOrigin,
  isUrlOnOrigin,
  type ChannelAttachmentTransport,
} from "../../shared/attachment-download.ts";
import { asRecord, readString } from "../../shared/core.ts";
import type { TeamsBotCredentials } from "./credentials.ts";
import { normalizeTeamsServiceUrl, TEAMS_CONNECTOR_ORIGIN } from "./service-url.ts";

export const TEAMS_BOT_FRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_MARGIN_SECONDS = 300;
const MAX_ERROR_DETAIL_CHARACTERS = 300;
const MISSING_ACCESS_TOKEN_CODE = "missing_access_token";

export class TeamsBotAuthenticationError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(input: { readonly code?: string; readonly status: number }) {
    super(
      `Teams bot token request was rejected with HTTP ${String(input.status)}${
        input.code ? ` (${input.code})` : ""
      }.`,
    );
    this.name = "TeamsBotAuthenticationError";
    this.status = input.status;
    if (input.code) this.code = input.code;
  }
}

/**
 * `authentication`: the bot token request failed, so no activity request was sent.
 * `connector`: the activity request itself failed and may or may not have been applied.
 */
export type TeamsConnectorErrorStage = "authentication" | "connector";

export class TeamsConnectorError extends Error {
  readonly code?: string;
  /** The request was not applied by Teams; retrying the same request will not succeed. */
  readonly definitiveRejection: boolean;
  readonly retryable: boolean;
  readonly stage: TeamsConnectorErrorStage;
  readonly status?: number;

  constructor(input: {
    readonly code?: string;
    readonly definitiveRejection: boolean;
    readonly message: string;
    readonly retryable: boolean;
    readonly stage: TeamsConnectorErrorStage;
    readonly status?: number;
  }) {
    super(input.message);
    this.name = "TeamsConnectorError";
    if (input.code) this.code = input.code;
    this.definitiveRejection = input.definitiveRejection;
    this.retryable = input.retryable;
    this.stage = input.stage;
    if (input.status !== undefined) this.status = input.status;
  }
}

export interface TeamsOutboundActivity {
  readonly entities?: readonly Readonly<Record<string, unknown>>[];
  readonly text: string;
  readonly textFormat?: "markdown";
  readonly type: "message" | "typing";
}

export interface TeamsConnectorClient {
  sendActivity(input: {
    readonly activity: TeamsOutboundActivity;
    readonly conversationId: string;
    readonly credentials: TeamsBotCredentials;
    readonly serviceUrl: string;
  }): Promise<{ readonly id?: string }>;
  updateActivity(input: {
    readonly activity: TeamsOutboundActivity;
    readonly activityId: string;
    readonly conversationId: string;
    readonly credentials: TeamsBotCredentials;
    readonly serviceUrl: string;
  }): Promise<void>;
  downloadAttachment(input: {
    readonly contentUrl: string;
    readonly credentials: TeamsBotCredentials;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<Uint8Array>;
}

interface CachedBotToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface BotTokenCache {
  readonly inFlight: Map<string, Promise<string>>;
  readonly tokens: Map<string, CachedBotToken>;
}

/**
 * Process-wide bot token caches, one per fetch implementation so injected test transports are
 * isolated from production tokens.
 */
const botTokenCaches = new WeakMap<typeof fetch, BotTokenCache>();

function botTokenCacheKey(credentials: TeamsBotCredentials) {
  const passwordHash = createHash("sha256").update(credentials.appPassword).digest("hex");
  return `${credentials.appId}\u0000${credentials.appTenantId}\u0000${passwordHash}`;
}

async function responseJson(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function transportError(error: unknown, operation: string, stage: TeamsConnectorErrorStage) {
  if (error instanceof TeamsConnectorError || error instanceof TeamsBotAuthenticationError) {
    return error;
  }
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new TeamsConnectorError({
    definitiveRejection: false,
    message: `Teams ${operation} ${timedOut ? "timed out" : "failed before a response was received"}.`,
    retryable: true,
    stage,
  });
}

function connectorErrorFromResponse(
  status: number,
  body: Record<string, unknown> | undefined,
  operation: string,
  stage: TeamsConnectorErrorStage,
) {
  const error = asRecord(body?.error);
  const code = readString(error, "code");
  const detail = readString(error, "message")?.slice(0, MAX_ERROR_DETAIL_CHARACTERS);
  return new TeamsConnectorError({
    ...(code ? { code } : {}),
    // 401 means the cached bot token was rejected; it is invalidated so a retry re-authenticates.
    definitiveRejection: status === 400 || status === 403 || status === 404,
    message: `Teams ${operation} failed with HTTP ${String(status)}${code ? ` (${code})` : ""}${
      detail ? `: ${detail}` : ""
    }.`,
    retryable: status === 401 || status === 408 || status === 429 || status >= 500,
    stage,
    status,
  });
}

function botTokenDownloadFailure(error: unknown) {
  if (error instanceof TeamsBotAuthenticationError) {
    return new ChannelAttachmentDownloadError("credential_invalid");
  }
  if (!(error instanceof TeamsConnectorError) || error.status === undefined) {
    return new ChannelAttachmentDownloadError("unreachable");
  }
  if (error.code === MISSING_ACCESS_TOKEN_CODE) {
    return new ChannelAttachmentDownloadError("malformed_response");
  }
  return ChannelAttachmentDownloadError.forStatus(error.status);
}

export function teamsConnectorClient(
  options: ChannelAttachmentTransport & {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {},
): TeamsConnectorClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Teams connector timeout must be a positive integer.");
  }
  let cache = botTokenCaches.get(fetchImpl);
  if (!cache) {
    cache = { inFlight: new Map(), tokens: new Map() };
    botTokenCaches.set(fetchImpl, cache);
  }
  const tokenCache = cache;

  async function requestBotToken(credentials: TeamsBotCredentials, key: string) {
    let response: Response;
    try {
      response = await fetchImpl(
        `https://login.microsoftonline.com/${encodeURIComponent(credentials.appTenantId)}/oauth2/v2.0/token`,
        {
          body: new URLSearchParams({
            client_id: credentials.appId,
            client_secret: credentials.appPassword,
            grant_type: "client_credentials",
            scope: TEAMS_BOT_FRAMEWORK_TOKEN_SCOPE,
          }).toString(),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      throw transportError(error, "bot token request", "authentication");
    }
    const body = await responseJson(response);
    if (response.status === 400 || response.status === 401) {
      const code = readString(body, "error");
      throw new TeamsBotAuthenticationError({ ...(code ? { code } : {}), status: response.status });
    }
    if (!response.ok) {
      throw connectorErrorFromResponse(
        response.status,
        body,
        "bot token request",
        "authentication",
      );
    }
    const accessToken = readString(body, "access_token");
    const expiresIn = body?.expires_in;
    if (!accessToken) {
      throw new TeamsConnectorError({
        code: MISSING_ACCESS_TOKEN_CODE,
        definitiveRejection: false,
        message: "Teams bot token response did not include an access token.",
        retryable: false,
        stage: "authentication",
        status: response.status,
      });
    }
    const lifetimeSeconds =
      typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? +expiresIn : 0;
    if (Number.isFinite(lifetimeSeconds) && lifetimeSeconds > TOKEN_EXPIRY_MARGIN_SECONDS) {
      tokenCache.tokens.set(key, {
        accessToken,
        expiresAt: now() + (lifetimeSeconds - TOKEN_EXPIRY_MARGIN_SECONDS) * 1_000,
      });
    }
    return accessToken;
  }

  function botToken(credentials: TeamsBotCredentials) {
    const key = botTokenCacheKey(credentials);
    const cached = tokenCache.tokens.get(key);
    if (cached && cached.expiresAt > now())
      return { key, token: Promise.resolve(cached.accessToken) };
    tokenCache.tokens.delete(key);
    let pending = tokenCache.inFlight.get(key);
    if (!pending) {
      pending = requestBotToken(credentials, key).finally(() => tokenCache.inFlight.delete(key));
      tokenCache.inFlight.set(key, pending);
    }
    return { key, token: pending };
  }

  async function connectorRequest(input: {
    readonly body: object;
    readonly credentials: TeamsBotCredentials;
    readonly method: "POST" | "PUT";
    readonly operation: string;
    readonly path: string;
    readonly serviceUrl: string;
  }) {
    const serviceUrl = normalizeTeamsServiceUrl(input.serviceUrl);
    const { key, token } = botToken(input.credentials);
    const accessToken = await token;
    let response: Response;
    try {
      response = await fetchImpl(`${serviceUrl}${input.path}`, {
        body: JSON.stringify(input.body),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transportError(error, input.operation, "connector");
    }
    const body = await responseJson(response);
    if (response.status === 401) tokenCache.tokens.delete(key);
    if (!response.ok) {
      throw connectorErrorFromResponse(response.status, body, input.operation, "connector");
    }
    return body;
  }

  function conversationPath(conversationId: string) {
    const id = conversationId.trim();
    if (!id) throw new TypeError("Teams conversation id is required.");
    return `v3/conversations/${encodeURIComponent(id)}/activities`;
  }

  return {
    async sendActivity(input) {
      const body = await connectorRequest({
        body: input.activity,
        credentials: input.credentials,
        method: "POST",
        operation: "send activity",
        path: conversationPath(input.conversationId),
        serviceUrl: input.serviceUrl,
      });
      const id = readString(body, "id");
      return id ? { id } : {};
    },
    async updateActivity(input) {
      const activityId = input.activityId.trim();
      if (!activityId) throw new TypeError("Teams activity id is required.");
      await connectorRequest({
        body: { ...input.activity, id: activityId },
        credentials: input.credentials,
        method: "PUT",
        operation: "update activity",
        path: `${conversationPath(input.conversationId)}/${encodeURIComponent(activityId)}`,
        serviceUrl: input.serviceUrl,
      });
    },
    async downloadAttachment(input) {
      if (!isUrlOnOrigin(input.contentUrl, TEAMS_CONNECTOR_ORIGIN)) {
        throw new ChannelAttachmentDownloadError("host_not_allowed");
      }
      const { key, token } = botToken(input.credentials);
      let accessToken: string;
      try {
        accessToken = await token;
      } catch (error) {
        throw botTokenDownloadFailure(error);
      }
      try {
        return await downloadFromOrigin({
          headers: { authorization: `Bearer ${accessToken}` },
          maxBytes: input.maxBytes,
          origin: TEAMS_CONNECTOR_ORIGIN,
          signal: input.signal,
          transport: options,
          url: input.contentUrl,
        });
      } catch (error) {
        if (error instanceof ChannelAttachmentDownloadError && error.status === 401) {
          tokenCache.tokens.delete(key);
        }
        throw error;
      }
    },
  };
}
