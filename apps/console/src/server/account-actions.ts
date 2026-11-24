import "@tanstack/react-start/server-only";
import type {
  EmailChangeStarted,
  MfaEnrollment,
  RecoveryCodes,
} from "../account/account-security.ts";
import { accountCall } from "./account-data.ts";

export function revokeAccountSession(accessToken: string, sessionId: string) {
  return accountCall<{ readonly current: boolean }>("revokeAccountSession", {
    accessToken,
    method: "DELETE",
    path: `/v1/account/sessions/${encodeURIComponent(sessionId)}`,
  });
}

/** Ends the identity browser session the access token was issued from (this browser only). */
export async function signOutBrowser(accessToken: string) {
  await accountCall<Record<string, never>>("signOutBrowser", {
    accessToken,
    method: "POST",
    path: "/v1/account/sign-out",
  });
}

export function signOutEverywhere(accessToken: string) {
  return accountCall<Record<string, never>>("signOutEverywhere", {
    accessToken,
    method: "POST",
    path: "/v1/account/sign-out-all",
  });
}

export function changeAccountPassword(
  accessToken: string,
  body: { readonly currentPassword: string; readonly password: string },
) {
  return accountCall<Record<string, never>>("changeAccountPassword", {
    accessToken,
    body,
    method: "POST",
    path: "/v1/account/password",
  });
}

export function beginMfaEnrollment(accessToken: string, password: string) {
  return accountCall<MfaEnrollment>("beginMfaEnrollment", {
    accessToken,
    body: { password },
    method: "POST",
    path: "/v1/account/mfa/enrollment",
  });
}

export function confirmMfaEnrollment(accessToken: string, code: string) {
  return accountCall<RecoveryCodes>("confirmMfaEnrollment", {
    accessToken,
    body: { code },
    method: "POST",
    path: "/v1/account/mfa/enrollment/confirm",
  });
}

export function disableMfa(accessToken: string, code: string) {
  return accountCall<Record<string, never>>("disableMfa", {
    accessToken,
    body: { code },
    method: "POST",
    path: "/v1/account/mfa/disable",
  });
}

export function regenerateRecoveryCodes(accessToken: string, code: string) {
  return accountCall<RecoveryCodes>("regenerateRecoveryCodes", {
    accessToken,
    body: { code },
    method: "POST",
    path: "/v1/account/mfa/recovery-codes",
  });
}

export function requestEmailChange(
  accessToken: string,
  body: { readonly code?: string; readonly newEmail: string; readonly password: string },
) {
  return accountCall<EmailChangeStarted>("requestEmailChange", {
    accessToken,
    body,
    method: "POST",
    path: "/v1/account/email-change",
  });
}

export function cancelEmailChange(accessToken: string) {
  return accountCall<Record<string, never>>("cancelEmailChange", {
    accessToken,
    method: "DELETE",
    path: "/v1/account/email-change",
  });
}

export function deleteAccount(
  accessToken: string,
  body: { readonly code?: string; readonly password: string },
) {
  return accountCall<Record<string, never>>("deleteAccount", {
    accessToken,
    body,
    method: "POST",
    path: "/v1/account/delete",
  });
}
