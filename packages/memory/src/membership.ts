import {
  canonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  memoryPersistence,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";

type Component = Extract<PlatformRecord, { readonly itemType: "memory-search-component" }>;

export interface MemorySearchMembershipDigest {
  readonly digest: string;
  readonly keyVersion: number;
}

export const MEMORY_SEARCH_MEMBERSHIP_SHARDS = 16;

export function memorySearchMembershipShard(value: string) {
  return (
    createHash("sha256").update(value).digest().readUInt32BE(0) % MEMORY_SEARCH_MEMBERSHIP_SHARDS
  );
}

export async function resolveMemorySearchTargetMembership(args: {
  readonly components: readonly Component[];
  readonly database: DynamoDatabaseService;
  readonly digestCandidates: readonly MemorySearchMembershipDigest[];
}) {
  const matches: MemorySearchMembershipDigest[] = [];
  for (const candidate of args.digestCandidates) {
    let matchesEveryComponent = true;
    for (const component of args.components) {
      const data = {
        generationId: component.data.generationId,
        membershipShard: memorySearchMembershipShard(candidate.digest),
        targetDigest: candidate.digest,
      };
      const keys = canonicalRecordKeys(
        { data, itemType: "memory-search-generation-target" },
        "control",
      );
      const value = await memoryPersistence.read(args.database, "control", keys, true);
      if (
        !value ||
        value.itemType !== "memory-search-generation-target" ||
        value.data.keyVersion !== candidate.keyVersion ||
        value.data.targetDigest !== candidate.digest
      ) {
        matchesEveryComponent = false;
        break;
      }
    }
    if (matchesEveryComponent) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error("Persisted target membership is unavailable or ambiguous.");
  }
  return matches[0]!;
}
