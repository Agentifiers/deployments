import "@tanstack/react-start/server-only";
import type {
  AccountProfile,
  AccountSecurity,
  AccountSessionPage,
} from "../account/account-security.ts";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import { consoleConfig } from "./config.ts";

/**
 * The person's own account security lives on the identity service, not the platform API. The
 * console calls its `/v1/account/` routes server-side with the same access token it sends the
 * platform API; identity checks that the token's browser session is still live. Identity errors
 * are OAuth-shaped (`error`, `error_description`), so they are mapped onto the problem shape the
 * console's dialogs already render.
 */
export async function accountCall<Result>(
  operation: string,
  input: {
    readonly accessToken: string;
    readonly body?: Readonly<Record<string, unknown>>;
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result> {
  const url = new URL(input.path, consoleConfig().identityIssuer);
  const response = await fetchImpl(url, {
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    method: input.method,
    redirect: "error",
  });
  if (response.status === 401) {
    await response.body?.cancel();
    throw new UnauthenticatedError();
  }
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const description =
      typeof payload.error_description === "string" ? payload.error_description : undefined;
    throw new PlatformApiError(operation, {
      ...(typeof payload.error === "string" ? { code: payload.error } : {}),
      ...(description ? { detail: description } : {}),
      status: response.status,
      title: description ?? (response.status === 429 ? "Too many attempts" : "Request failed"),
    });
  }
  return payload as Result;
}

export function loadAccountSecurity(accessToken: string) {
  return accountCall<AccountSecurity>("getAccountSecurity", {
    accessToken,
    method: "GET",
    path: "/v1/account/security",
  });
}

export function loadAccountSessionPage(accessToken: string, cursor: string | undefined) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  return accountCall<AccountSessionPage>("listAccountSessions", {
    accessToken,
    method: "GET",
    path: `/v1/account/sessions${query}`,
  });
}

export function loadAccountProfile(accessToken: string) {
  return accountCall<AccountProfile>("getAccountProfile", {
    accessToken,
    method: "GET",
    path: "/v1/account/profile",
  });
}
