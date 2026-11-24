import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { IdentityError } from "./errors.ts";

const UNIVERSALLY_COMPROMISED = new Set([
  "123456789012345",
  "correcthorsebatterystaple",
  "passwordpassword",
  "qwertyuiopasdfgh",
]);

export interface PasswordProfile {
  readonly blockSize: number;
  readonly keyLength: number;
  readonly memoryCost: number;
  readonly parallelization: number;
  readonly pepper?: string;
  readonly pepperVersion?: string;
  readonly saltLength: number;
  readonly version: 1;
}

export interface PasswordVerification {
  readonly matched: boolean;
  readonly needsRehash: boolean;
  readonly replacementHash?: string;
}

interface EncodedPasswordHash {
  readonly derived: Buffer;
  readonly profile: Omit<PasswordProfile, "pepper">;
  readonly salt: Buffer;
}

export const DEFAULT_PASSWORD_PROFILE: PasswordProfile = {
  blockSize: 8,
  keyLength: 32,
  memoryCost: 131_072,
  parallelization: 1,
  saltLength: 16,
  version: 1,
};

export function validatePasswordInput(password: string): void {
  if (Array.from(password).length < 15) {
    throw new IdentityError("invalid_request", "Password must contain at least 15 characters.", {
      exposeDescription: true,
    });
  }
  if (Buffer.byteLength(password, "utf8") > 1_024) {
    throw new IdentityError("invalid_request", "Password must not exceed 1,024 UTF-8 bytes.", {
      exposeDescription: true,
    });
  }
  if (UNIVERSALLY_COMPROMISED.has(password.toLowerCase())) {
    throw new IdentityError("invalid_request", "Choose a less commonly compromised password.", {
      exposeDescription: true,
    });
  }
}

function passwordMaterial(password: string, profile: PasswordProfile): Buffer {
  return profile.pepper
    ? createHmac("sha256", profile.pepper).update(password, "utf8").digest()
    : Buffer.from(password, "utf8");
}

async function derive(password: string, salt: Buffer, profile: PasswordProfile): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    nodeScrypt(
      passwordMaterial(password, profile),
      salt,
      profile.keyLength,
      {
        N: profile.memoryCost,
        p: profile.parallelization,
        r: profile.blockSize,
        maxmem: Math.max(32 * 1_024 * 1_024, 256 * profile.memoryCost * profile.blockSize),
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}

function profileKey(profile: Omit<PasswordProfile, "pepper">): string {
  return [
    profile.version,
    profile.memoryCost,
    profile.blockSize,
    profile.parallelization,
    profile.keyLength,
    profile.saltLength,
    profile.pepperVersion ?? "-",
  ].join(":");
}

function encode(profile: PasswordProfile, salt: Buffer, derived: Buffer): string {
  return [
    "scrypt",
    "v=1",
    `N=${profile.memoryCost}`,
    `r=${profile.blockSize}`,
    `p=${profile.parallelization}`,
    `l=${profile.keyLength}`,
    `s=${profile.saltLength}`,
    `pepper=${profile.pepperVersion ?? "-"}`,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function parse(encoded: string): EncodedPasswordHash | undefined {
  const fields = encoded.split("$");
  if (fields.length !== 10 || fields[0] !== "scrypt" || fields[1] !== "v=1") return undefined;
  const number = (prefix: string, value: string | undefined) => {
    if (!value?.startsWith(prefix)) return undefined;
    const parsed = Number(value.slice(prefix.length));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const memoryCost = number("N=", fields[2]);
  const blockSize = number("r=", fields[3]);
  const parallelization = number("p=", fields[4]);
  const keyLength = number("l=", fields[5]);
  const saltLength = number("s=", fields[6]);
  const pepper = fields[7]?.startsWith("pepper=") ? fields[7].slice(7) : undefined;
  if (!memoryCost || !blockSize || !parallelization || !keyLength || !saltLength || !pepper) {
    return undefined;
  }
  try {
    const salt = Buffer.from(fields[8]!, "base64url");
    const derived = Buffer.from(fields[9]!, "base64url");
    if (salt.length !== saltLength || derived.length !== keyLength) return undefined;
    return {
      derived,
      profile: {
        blockSize,
        keyLength,
        memoryCost,
        parallelization,
        ...(pepper === "-" ? {} : { pepperVersion: pepper }),
        saltLength,
        version: 1,
      },
      salt,
    };
  } catch {
    return undefined;
  }
}

export async function hashPassword(
  password: string,
  profile: PasswordProfile = DEFAULT_PASSWORD_PROFILE,
): Promise<string> {
  validatePasswordInput(password);
  const salt = randomBytes(profile.saltLength);
  return encode(profile, salt, await derive(password, salt, profile));
}

export async function verifyPasswordEqualized(input: {
  readonly encodedHash?: string;
  readonly password: string;
  readonly profiles: readonly [PasswordProfile, PasswordProfile?];
}): Promise<PasswordVerification> {
  if (input.profiles.length > 2) throw new Error("At most two password profiles are supported.");
  const parsed = input.encodedHash ? parse(input.encodedHash) : undefined;
  let matchedProfile = -1;
  let currentCandidate: string | undefined;
  for (const [index, profile] of input.profiles.entries()) {
    if (!profile) continue;
    const isStoredProfile = parsed && profileKey(parsed.profile) === profileKey(profile);
    const salt = isStoredProfile ? parsed.salt : randomBytes(profile.saltLength);
    const candidate = await derive(input.password, salt, profile);
    if (index === 0 && !isStoredProfile) currentCandidate = encode(profile, salt, candidate);
    if (
      isStoredProfile &&
      candidate.length === parsed.derived.length &&
      timingSafeEqual(candidate, parsed.derived)
    ) {
      matchedProfile = index;
    }
  }
  return matchedProfile < 0
    ? { matched: false, needsRehash: false }
    : matchedProfile === 0
      ? { matched: true, needsRehash: false }
      : {
          matched: true,
          needsRehash: true,
          ...(currentCandidate ? { replacementHash: currentCandidate } : {}),
        };
}
