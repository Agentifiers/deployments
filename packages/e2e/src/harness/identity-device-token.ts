import { fetchResendingGatewayThrottles } from "./http-client.ts";
import type { IssuedPlatformToken } from "./platform-credential.ts";

/** A human identity that signs in to the identity origin with a password. */
export interface IdentityPasswordCredentials {
  readonly issuer: string;
  readonly password: string;
  readonly username: string;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

export async function responseJson(response: Response, label: string) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned HTTP ${response.status} with an invalid response.`);
  }
  if (!response.ok) {
    const record = jsonRecord(body, label);
    const detail =
      typeof record.error_description === "string"
        ? record.error_description
        : typeof record.title === "string"
          ? record.title
          : undefined;
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return jsonRecord(body, label);
}

function responseCookiePairs(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value!.split(";", 1)[0]!).filter(Boolean);
}

export function cookieHeader(cookies: ReadonlyMap<string, string>) {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

export function captureCookies(cookies: Map<string, string>, response: Response) {
  for (const pair of responseCookiePairs(response)) {
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

export function issuedPlatformToken(
  token: string,
  expiresIn: unknown,
  label: string,
): IssuedPlatformToken {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`${label} returned an invalid token lifetime.`);
  }
  const issuedAtMs = Date.now();
  return { expiresAtMs: issuedAtMs + expiresIn * 1_000, issuedAtMs, token };
}

/**
 * Mints a short-lived platform bearer token for a password identity: start a `deployments-cli`
 * device authorization at the API origin, sign in at the identity origin, claim and approve
 * the user code there, then exchange the device code. The password goes only to the configured
 * identity origin; the verification URI, a console page a person would open, is checked for
 * shape and never fetched.
 */
export async function deviceAuthorizedPlatformToken(
  apiUrl: string,
  credentials: IdentityPasswordCredentials,
): Promise<IssuedPlatformToken> {
  const apiOrigin = new URL(apiUrl);
  const issuer = new URL(credentials.issuer);
  const started = await responseJson(
    await fetchResendingGatewayThrottles(new URL("/v1/device-authorizations", apiOrigin), {
      body: JSON.stringify({ clientId: "deployments-cli" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    }),
    "Platform device authorization",
  );
  const deviceCode = started.deviceCode;
  const userCode = started.userCode;
  const verificationUri = started.verificationUri;
  if (
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof userCode !== "string" ||
    !userCode ||
    typeof verificationUri !== "string"
  ) {
    throw new Error("Platform device authorization returned incomplete grant details.");
  }
  const verification = new URL(verificationUri);
  if (
    verification.protocol !== "https:" ||
    verification.username ||
    verification.password ||
    verification.pathname !== "/device"
  ) {
    throw new Error("Platform device authorization returned an unexpected verification URI.");
  }
  const cookies = new Map<string, string>();
  const ui = await fetchResendingGatewayThrottles(new URL("/sign-in", issuer), {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!ui.ok) throw new Error(`Identity sign-in page returned HTTP ${ui.status}.`);
  captureCookies(cookies, ui);
  const csrfEntry = [...cookies].find(([name]) => name.endsWith("dpl_csrf"));
  if (!csrfEntry?.[1]) throw new Error("Identity sign-in page did not set a CSRF cookie.");
  const mutation = async (path: string, body: Record<string, string>, label: string) => {
    const response = await fetchResendingGatewayThrottles(new URL(path, issuer), {
      body: JSON.stringify(body),
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
    captureCookies(cookies, response);
    if (response.status === 204) return undefined;
    return responseJson(response, label);
  };
  await mutation(
    "/v1/auth/sign-in",
    { email: credentials.username, password: credentials.password },
    "Identity sign-in",
  );
  await mutation("/v1/device/claim", { userCode }, "Identity device claim");
  await mutation("/v1/device/approve", { userCode }, "Identity device approval");
  const exchanged = await responseJson(
    await fetchResendingGatewayThrottles(new URL("/v1/device-authorizations/token", apiOrigin), {
      body: JSON.stringify({ deviceCode }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    }),
    "Platform device token exchange",
  );
  if (
    exchanged.tokenType !== "Bearer" ||
    typeof exchanged.bearerToken !== "string" ||
    !exchanged.bearerToken
  ) {
    throw new Error("Platform device token exchange returned an invalid bearer token.");
  }
  return issuedPlatformToken(
    exchanged.bearerToken,
    exchanged.expiresIn,
    "Platform device token exchange",
  );
}
