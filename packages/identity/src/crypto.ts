import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface RandomSource {
  readonly bytes: (length: number) => Uint8Array;
}

export const systemRandom: RandomSource = {
  bytes: (length) => randomBytes(length),
};

export function base64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

export function randomToken(random: RandomSource = systemRandom): string {
  return base64Url(random.bytes(32));
}

export function refreshToken(random: RandomSource = systemRandom): string {
  return `dpl_rt_${randomToken(random)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash) && left.length === right.length;
}

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function humanUserCode(random: RandomSource = systemRandom): string {
  const bytes = random.bytes(8);
  const characters = Array.from(
    bytes,
    (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length],
  );
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
}
