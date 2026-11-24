import { randomBytes } from "node:crypto";
import { validatePasswordInput } from "@deployments-ai/identity";
import type { StoredSecret } from "./secrets.ts";

/** A 256-bit random password that satisfies the identity service's password rules. */
export function generateOperatorPassword() {
  const password = randomBytes(32).toString("base64url");
  validatePasswordInput(password);
  return password;
}

export type PasswordSecretAction =
  | { readonly kind: "generate" }
  | { readonly kind: "use"; readonly password: string };

/**
 * The password secret is the source of truth. A missing or empty secret, or `rotate`, gets a
 * newly generated password written before the identity is reconciled to it, so a failed identity
 * write converges on the next run.
 */
export function passwordSecretAction(input: {
  readonly rotate: boolean;
  readonly secret: StoredSecret;
  readonly secretId: string;
}): PasswordSecretAction {
  if (input.secret.kind === "missing" || !input.secret.current || input.rotate) {
    return { kind: "generate" };
  }
  const password = input.secret.current.value;
  try {
    validatePasswordInput(password);
  } catch {
    throw new Error(
      `Secret ${input.secretId} does not hold a usable password; run identity with --rotate to replace it.`,
    );
  }
  return { kind: "use", password };
}

/** The password a sign-in reads from the secret; signing in never creates or changes it. */
export function storedPassword(input: {
  readonly secret: StoredSecret;
  readonly secretId: string;
}) {
  if (input.secret.kind === "missing" || !input.secret.current) {
    throw new Error(
      `Secret ${input.secretId} holds no password; run identity with --password-secret first.`,
    );
  }
  return input.secret.current.value;
}
