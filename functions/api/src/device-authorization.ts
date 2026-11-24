export class DeviceAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthorizationError";
  }
}

export interface DeviceAuthorizationService {
  start(): Promise<{
    readonly deviceCode: string;
    readonly expiresIn: number;
    readonly interval: number;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete?: string;
  }>;
  exchange(deviceCode: string): Promise<{
    readonly bearerToken: string;
    readonly expiresIn: number;
    readonly refreshToken?: string;
    readonly tokenType: "Bearer";
  }>;
  refresh(refreshToken: string): Promise<{
    readonly bearerToken: string;
    readonly expiresIn: number;
    readonly refreshToken?: string;
    readonly tokenType: "Bearer";
  }>;
  revoke(refreshToken: string): Promise<void>;
}

export interface DeviceAuthorizationServiceOptions {
  readonly bearerTokenSource: "access_token" | "id_token";
  readonly clientId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly scopes?: readonly string[];
}

interface OpenIdConfiguration {
  readonly deviceAuthorizationEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly tokenEndpoint: string;
}

const DEFAULT_IDENTITY_PROVIDER_REQUEST_TIMEOUT_MS = 5_000;

function text(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      `The identity provider did not return ${field}.`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      `The identity provider returned invalid ${field}.`,
    );
  }
  return Number(value);
}

function endpoint(value: unknown, field: string) {
  const parsed = new URL(text(value, field));
  if (
    parsed.protocol !== "https:" &&
    !(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  ) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      `The identity provider returned an insecure ${field}.`,
    );
  }
  return parsed.toString();
}

async function json(response: Response) {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an invalid response.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an invalid response.",
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function providerError(response: Response, body: Readonly<Record<string, unknown>>) {
  const code = typeof body.error === "string" ? body.error : "device_authorization_failed";
  const allowed = new Set([
    "access_denied",
    "authorization_pending",
    "expired_token",
    "invalid_client",
    "invalid_grant",
    "slow_down",
    "unauthorized_client",
  ]);
  return new DeviceAuthorizationError(
    response.status === 429 ? 429 : response.status >= 500 ? 503 : 400,
    allowed.has(code) ? code : "device_authorization_failed",
    typeof body.error_description === "string"
      ? body.error_description
      : "Device authorization failed.",
  );
}

function idTokenExpiresIn(token: string, now: () => number) {
  const parts = token.split(".");
  const payloadSegment = parts[1];
  if (parts.length !== 3 || !payloadSegment || !/^[A-Za-z0-9_-]+$/u.test(payloadSegment)) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an invalid id_token.",
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an invalid id_token.",
    );
  }
  const expiration =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>).exp
      : undefined;
  if (!Number.isSafeInteger(expiration)) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an id_token without a valid exp claim.",
    );
  }
  const expiresIn = Math.floor(Number(expiration) - now() / 1_000);
  if (expiresIn < 1) {
    throw new DeviceAuthorizationError(
      503,
      "device_authorization_unavailable",
      "The identity provider returned an expired id_token.",
    );
  }
  return expiresIn;
}

function deviceToken(
  body: Readonly<Record<string, unknown>>,
  bearerTokenSource: DeviceAuthorizationServiceOptions["bearerTokenSource"],
  now: () => number,
) {
  const bearerToken = text(body[bearerTokenSource], bearerTokenSource);
  return {
    bearerToken,
    expiresIn:
      bearerTokenSource === "id_token"
        ? idTokenExpiresIn(bearerToken, now)
        : positiveInteger(body.expires_in, "expires_in"),
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    tokenType: "Bearer" as const,
  };
}

export function createDeviceAuthorizationService(
  options: DeviceAuthorizationServiceOptions,
): DeviceAuthorizationService {
  const fetch = options.fetch ?? globalThis.fetch;
  const issuer = new URL(options.issuer.replace(/\/+$/u, ""));
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_IDENTITY_PROVIDER_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError("requestTimeoutMs must be a positive integer.");
  }
  let configuration: Promise<OpenIdConfiguration> | undefined;

  const discover = async () => {
    configuration ??= (async () => {
      let response: Response;
      try {
        response = await fetch(
          new URL(`${issuer.toString().replace(/\/$/u, "")}/.well-known/openid-configuration`),
          {
            headers: { accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(requestTimeoutMs),
          },
        );
      } catch {
        throw new DeviceAuthorizationError(
          503,
          "device_authorization_unavailable",
          "The identity provider is unavailable.",
        );
      }
      if (!response.ok) {
        throw new DeviceAuthorizationError(
          503,
          "device_authorization_unavailable",
          "The identity provider does not advertise device authorization.",
        );
      }
      const body = await json(response);
      return {
        deviceAuthorizationEndpoint: endpoint(
          body.device_authorization_endpoint,
          "device_authorization_endpoint",
        ),
        ...(typeof body.revocation_endpoint === "string"
          ? { revocationEndpoint: endpoint(body.revocation_endpoint, "revocation_endpoint") }
          : {}),
        tokenEndpoint: endpoint(body.token_endpoint, "token_endpoint"),
      };
    })();
    try {
      return await configuration;
    } catch (error) {
      configuration = undefined;
      throw error;
    }
  };

  const post = async (url: string, body: URLSearchParams) => {
    let response: Response;
    try {
      response = await fetch(url, {
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new DeviceAuthorizationError(
        503,
        "device_authorization_unavailable",
        "The identity provider is unavailable.",
      );
    }
    const payload = await json(response);
    if (!response.ok) throw providerError(response, payload);
    return payload;
  };

  const postRevocation = async (url: string, body: URLSearchParams) => {
    let response: Response;
    try {
      response = await fetch(url, {
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new DeviceAuthorizationError(
        503,
        "device_authorization_unavailable",
        "The identity provider is unavailable.",
      );
    }
    if (!response.ok) throw providerError(response, await json(response));
  };

  return {
    async start() {
      const discovered = await discover();
      const body = await post(
        discovered.deviceAuthorizationEndpoint,
        new URLSearchParams({
          client_id: options.clientId,
          scope: (options.scopes ?? ["openid", "email", "profile", "offline_access"]).join(" "),
        }),
      );
      return {
        deviceCode: text(body.device_code, "device_code"),
        expiresIn: positiveInteger(body.expires_in, "expires_in"),
        interval: positiveInteger(body.interval ?? 5, "interval"),
        userCode: text(body.user_code, "user_code"),
        verificationUri: text(body.verification_uri, "verification_uri"),
        ...(typeof body.verification_uri_complete === "string"
          ? { verificationUriComplete: body.verification_uri_complete }
          : {}),
      };
    },
    async exchange(deviceCode) {
      if (!deviceCode.trim()) {
        throw new DeviceAuthorizationError(400, "invalid_request", "deviceCode is required.");
      }
      const discovered = await discover();
      const body = await post(
        discovered.tokenEndpoint,
        new URLSearchParams({
          client_id: options.clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      return deviceToken(body, options.bearerTokenSource, now);
    },
    async refresh(refreshToken) {
      if (!refreshToken.trim()) {
        throw new DeviceAuthorizationError(400, "invalid_request", "refreshToken is required.");
      }
      const discovered = await discover();
      const body = await post(
        discovered.tokenEndpoint,
        new URLSearchParams({
          client_id: options.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      );
      return deviceToken(body, options.bearerTokenSource, now);
    },
    async revoke(refreshToken) {
      if (!refreshToken.trim()) {
        throw new DeviceAuthorizationError(400, "invalid_request", "refreshToken is required.");
      }
      const discovered = await discover();
      if (!discovered.revocationEndpoint) {
        throw new DeviceAuthorizationError(
          503,
          "device_authorization_unavailable",
          "The identity provider does not advertise token revocation.",
        );
      }
      await postRevocation(
        discovered.revocationEndpoint,
        new URLSearchParams({
          client_id: options.clientId,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }),
      );
    },
  };
}
