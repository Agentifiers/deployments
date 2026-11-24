import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256, systemRandom, type RandomSource } from "./crypto.ts";

/** RFC 6238 profile every authenticator app accepts: HMAC-SHA-1, six digits, 30-second steps. */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Steps either side of the current one a code may come from, for clock drift. */
export const TOTP_DRIFT_STEPS = 1;
const TOTP_SECRET_BYTES = 20;

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 16;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text.replace(/=+$/u, "").toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) throw new TypeError("Invalid base32 text.");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/** A fresh shared secret, base32-encoded as authenticator apps expect it. */
export function generateTotpSecret(random: RandomSource = systemRandom): string {
  return base32Encode(random.bytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP over a 64-bit counter. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1_000 / TOTP_PERIOD_SECONDS);
}

/**
 * The step a six-digit code was generated in, searched within the drift window, or `undefined`.
 * Callers store the step and refuse any later code from the same or an earlier step, which stops
 * an observed code from being replayed.
 */
export function matchTotpStep(input: {
  readonly at: Date;
  readonly code: string;
  readonly notAfterStep?: number;
  readonly secret: string;
}): number | undefined {
  const code = input.code.replace(/\s+/gu, "");
  if (!/^\d{6}$/u.test(code)) return undefined;
  const secret = base32Decode(input.secret);
  const current = totpStep(input.at);
  let matched: number | undefined;
  for (let step = current - TOTP_DRIFT_STEPS; step <= current + TOTP_DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === undefined) matched = step;
  }
  if (matched === undefined) return undefined;
  return input.notAfterStep !== undefined && matched <= input.notAfterStep ? undefined : matched;
}

/** The `otpauth://` URI authenticator apps read from a QR code or a pasted link. */
export function totpUri(input: {
  readonly account: string;
  readonly issuer: string;
  readonly secret: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const parameters = new URLSearchParams({
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    issuer: input.issuer,
    period: String(TOTP_PERIOD_SECONDS),
    secret: input.secret,
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/** Strips separators and case so a recovery code matches however the person typed it. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-7]/gu, "");
}

/** Recovery codes carry 80 random bits, so a SHA-256 digest is as safe to store as a token hash. */
export function recoveryCodeHash(code: string): string {
  return sha256(`recovery-code\u0000${normalizeRecoveryCode(code)}`);
}

/** Ten single-use recovery codes, grouped in fours for reading aloud and typing. */
export function generateRecoveryCodes(random: RandomSource = systemRandom): readonly string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const characters = base32Encode(random.bytes(10)).slice(0, RECOVERY_CODE_LENGTH);
    return characters.match(/.{4}/gu)!.join("-");
  });
}

export function looksLikeRecoveryCode(input: string): boolean {
  return normalizeRecoveryCode(input).length === RECOVERY_CODE_LENGTH;
}
