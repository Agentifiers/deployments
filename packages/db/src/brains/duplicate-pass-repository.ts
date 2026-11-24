import type { Brain } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainDuplicatePassRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { activeBrainCondition } from "./authorization-conditions.ts";
import { brainPlatformRecord } from "./record-mapping.ts";

export type BrainDuplicatePass = Extract<
  PlatformRecord,
  { readonly itemType: "brain-duplicate-pass" }
>;

export async function getBrainDuplicatePass(
  database: DynamoDatabaseService,
  organizationId: string,
  brainId: string,
): Promise<BrainDuplicatePass | undefined> {
  const record = await database.getRecord(
    "execution",
    { pk: key("ORG", organizationId, "BRAIN", brainId), sk: key("BRAIN-DUPLICATE-PASS") },
    true,
  );
  return record?.itemType === "brain-duplicate-pass" ? record : undefined;
}

/**
 * Remembers the content fingerprint of a Brain's last completed duplicate pass while the Brain is
 * still active at the version the pass read. Resolves `false` without writing when the Brain
 * changed or a concurrent pass recorded first; the next pass compares against what is stored.
 */
export async function recordBrainDuplicatePass(
  database: DynamoDatabaseService,
  input: {
    readonly brain: Brain;
    readonly contentFingerprint: string;
    readonly duplicateGroups: number;
    readonly now: string;
    readonly previous: BrainDuplicatePass | undefined;
  },
): Promise<boolean> {
  const record = Schema.decodeUnknownSync(BrainDuplicatePassRecord)(
    withCanonicalRecordKeys({
      data: {
        brainId: input.brain.id,
        contentFingerprint: input.contentFingerprint,
        createdAt: input.previous?.data.createdAt ?? input.now,
        duplicateGroups: input.duplicateGroups,
        organizationId: input.brain.organizationId,
        updatedAt: input.now,
        version: input.previous ? input.previous.data.version + 1 : 0,
      },
      itemType: "brain-duplicate-pass" as const,
    }),
  );
  try {
    await database.transactWrite([
      activeBrainCondition(brainPlatformRecord(input.brain)),
      {
        kind: "put",
        ...(input.previous ? { previousRecord: input.previous } : {}),
        record,
      },
    ]);
    return true;
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return false;
    throw cause;
  }
}
