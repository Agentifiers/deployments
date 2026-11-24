import { createServerFn } from "@tanstack/react-start";
import {
  beginMfaEnrollment,
  cancelEmailChange,
  changeAccountPassword,
  confirmMfaEnrollment,
  deleteAccount,
  disableMfa,
  regenerateRecoveryCodes,
  requestEmailChange,
  revokeAccountSession,
  signOutEverywhere,
} from "../server/account-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, requireIds } from "./server-input.ts";

const MAX_SECRET_LENGTH = 1_024;

function requireText<const Field extends string>(input: unknown, names: readonly Field[]) {
  const record = fields(input);
  const values = {} as Record<Field, string>;
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string" || !value || value.length > MAX_SECRET_LENGTH) {
      throw new TypeError(`${name} must be a non-empty string of at most 1024 characters.`);
    }
    values[name] = value;
  }
  return values;
}

export const revokeAccountSessionFn = createServerFn({ method: "POST" })
  .validator((input: { readonly sessionId: string }) => requireIds(input, ["sessionId"]))
  .handler(async ({ data }) => revokeAccountSession(await requireAccessToken(), data.sessionId));

export const signOutEverywhereFn = createServerFn({ method: "POST" }).handler(async () =>
  signOutEverywhere(await requireAccessToken()),
);

export const changeAccountPasswordFn = createServerFn({ method: "POST" })
  .validator((input: { readonly currentPassword: string; readonly password: string }) =>
    requireText(input, ["currentPassword", "password"]),
  )
  .handler(async ({ data }) => changeAccountPassword(await requireAccessToken(), data));

export const beginMfaEnrollmentFn = createServerFn({ method: "POST" })
  .validator((input: { readonly password: string }) => requireText(input, ["password"]))
  .handler(async ({ data }) => beginMfaEnrollment(await requireAccessToken(), data.password));

export const confirmMfaEnrollmentFn = createServerFn({ method: "POST" })
  .validator((input: { readonly code: string }) => requireText(input, ["code"]))
  .handler(async ({ data }) => confirmMfaEnrollment(await requireAccessToken(), data.code));

export const disableMfaFn = createServerFn({ method: "POST" })
  .validator((input: { readonly code: string }) => requireText(input, ["code"]))
  .handler(async ({ data }) => disableMfa(await requireAccessToken(), data.code));

export const regenerateRecoveryCodesFn = createServerFn({ method: "POST" })
  .validator((input: { readonly code: string }) => requireText(input, ["code"]))
  .handler(async ({ data }) => regenerateRecoveryCodes(await requireAccessToken(), data.code));

/** The optional second-factor code, kept only when the person entered one. */
function optionalCode(input: unknown) {
  const { code } = fields(input);
  return code === undefined || code === "" ? {} : requireText({ code }, ["code"]);
}

export const requestEmailChangeFn = createServerFn({ method: "POST" })
  .validator(
    (input: { readonly code?: string; readonly newEmail: string; readonly password: string }) => ({
      ...requireText(input, ["newEmail", "password"]),
      ...optionalCode(input),
    }),
  )
  .handler(async ({ data }) => requestEmailChange(await requireAccessToken(), data));

export const cancelEmailChangeFn = createServerFn({ method: "POST" }).handler(async () =>
  cancelEmailChange(await requireAccessToken()),
);

export const deleteAccountFn = createServerFn({ method: "POST" })
  .validator((input: { readonly code?: string; readonly password: string }) => ({
    ...requireText(input, ["password"]),
    ...optionalCode(input),
  }))
  .handler(async ({ data }) => deleteAccount(await requireAccessToken(), data));
