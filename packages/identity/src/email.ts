import { sha256 } from "./crypto.ts";
import { IdentityError } from "./errors.ts";

const EMAIL_PATTERN =
  /^(?!.*\.\.)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export const EMAIL_NORMALIZATION_VERSION = 1;

export function normalizeEmail(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (Buffer.byteLength(normalized, "utf8") > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw new IdentityError("invalid_request", "Enter a valid email address.", {
      exposeDescription: true,
    });
  }
  return normalized;
}

export function emailClaimValue(normalizedEmail: string): string {
  return sha256(normalizedEmail);
}
