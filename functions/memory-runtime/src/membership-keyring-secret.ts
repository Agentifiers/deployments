import type { Ulid } from "@deployments-ai/db";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  currentMemoryMembershipDigest,
  decodeMemoryMembershipKeyring,
  type MemoryMembershipKeyring,
  memoryMembershipDigests,
} from "./membership-keyring.ts";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

export interface MemoryMembershipKeyringLoader {
  readonly load: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<MemoryMembershipKeyring>;
}

export function createMemoryMembershipKeyringLoader(args: {
  readonly now?: () => number;
  readonly readSecret: () => Promise<string>;
  readonly ttlMs?: number;
}): MemoryMembershipKeyringLoader {
  const now = args.now ?? Date.now;
  const ttlMs = args.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached:
    | {
        readonly keyring: MemoryMembershipKeyring;
        readonly loadedAt: number;
        readonly secret: string;
      }
    | undefined;
  let refresh: Promise<MemoryMembershipKeyring> | undefined;

  return {
    async load(options) {
      const loadedAt = now();
      if (!options?.forceRefresh && cached && loadedAt - cached.loadedAt < ttlMs) {
        return cached.keyring;
      }
      if (refresh) return refresh;
      refresh = (async () => {
        const secret = (await args.readSecret()).trim();
        if (!secret) throw new Error("Memory membership secret has no value.");
        const keyring =
          cached?.secret === secret ? cached.keyring : decodeMemoryMembershipKeyring(secret);
        cached = { keyring, loadedAt: now(), secret };
        return keyring;
      })();
      try {
        return await refresh;
      } finally {
        refresh = undefined;
      }
    },
  };
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const runtimeKeyring = createMemoryMembershipKeyringLoader({
  readSecret: () =>
    loadAwsSecretString(requiredEnvironment("DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN")),
});

export async function runtimeCurrentMemoryMembershipDigest(targetId: Ulid) {
  return currentMemoryMembershipDigest(await runtimeKeyring.load(), targetId);
}

export async function runtimeMemoryMembershipDigests(targetId: Ulid) {
  return memoryMembershipDigests(await runtimeKeyring.load(), targetId);
}
