import type { Ulid } from "@deployments-ai/db";
import { createHmac } from "node:crypto";

export interface MemoryMembershipKeyring {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, string>;
}

export function decodeMemoryMembershipKeyring(secret: string): MemoryMembershipKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch (cause) {
    throw new Error("Memory membership secret is not a versioned JSON keyring.", { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory membership keyring is invalid.");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(value.currentVersion) || (value.currentVersion as number) < 1) {
    throw new Error("Memory membership keyring has no valid current version.");
  }
  if (!value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) {
    throw new Error("Memory membership keyring has no versioned keys.");
  }
  const keys = new Map<number, string>();
  for (const [encodedVersion, candidate] of Object.entries(
    value.keys as Readonly<Record<string, unknown>>,
  )) {
    const version = Number(encodedVersion);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      String(version) !== encodedVersion ||
      typeof candidate !== "string" ||
      candidate.length < 32
    ) {
      throw new Error("Memory membership keyring contains an invalid versioned key.");
    }
    keys.set(version, candidate);
  }
  if (!keys.has(value.currentVersion as number)) {
    throw new Error("Memory membership keyring does not contain its current key.");
  }
  return { currentVersion: value.currentVersion as number, keys };
}

export function memoryMembershipDigests(keyring: MemoryMembershipKeyring, targetId: Ulid) {
  return [...keyring.keys.entries()]
    .sort(([left], [right]) => right - left)
    .map(([keyVersion, key]) => ({
      digest: createHmac("sha256", key).update(targetId).digest("hex"),
      keyVersion,
    }));
}

export function currentMemoryMembershipDigest(keyring: MemoryMembershipKeyring, targetId: Ulid) {
  return memoryMembershipDigests(keyring, targetId).find(
    ({ keyVersion }) => keyVersion === keyring.currentVersion,
  )!;
}
