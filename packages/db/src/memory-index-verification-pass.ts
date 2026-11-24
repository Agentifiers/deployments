import { Schema } from "effect";
import type { DynamoDatabaseService } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { key } from "./keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { MemoryIndexStatePosition, MemoryIndexVerificationPassRecord } from "./records/memory.ts";
import { isDatabaseWriteConflict } from "./transaction-conditions.ts";

export type MemoryIndexVerificationPass = Extract<
  PlatformRecord,
  { readonly itemType: "memory-index-verification-pass" }
>;

export interface MemoryIndexVerificationScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

export type MemoryIndexVerificationProgress = Pick<
  MemoryIndexVerificationPass["data"],
  "cutoff" | "indexStatus" | "resumeAfter"
>;

/** Where a later walk resumes after `state`, an index state read from its target's index. */
export function memoryIndexStatePosition(
  state: PlatformRecord,
): typeof MemoryIndexStatePosition.Type {
  return Schema.decodeUnknownSync(MemoryIndexStatePosition)(state);
}

export async function getMemoryIndexVerificationPass(
  database: DynamoDatabaseService,
  scope: MemoryIndexVerificationScope,
  targetId: Ulid,
): Promise<MemoryIndexVerificationPass | undefined> {
  const record = await database.getRecord(
    "control",
    {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key("MEMORY-INDEX-VERIFICATION-PASS", targetId, scope.workspaceId ?? "ENVIRONMENT"),
    },
    true,
  );
  return record?.itemType === "memory-index-verification-pass" ? record : undefined;
}

/**
 * Stores where the scope's verification walk over `targetId` resumes, creating the record or
 * advancing it by version from the record the walk read. Resolves `false` without writing when a
 * concurrent walk recorded first; the next walk resumes from what is stored.
 */
export async function recordMemoryIndexVerificationPass(
  database: DynamoDatabaseService,
  input: {
    readonly now: string;
    readonly previous: MemoryIndexVerificationPass | undefined;
    readonly progress: MemoryIndexVerificationProgress;
    readonly scope: MemoryIndexVerificationScope;
    readonly targetId: Ulid;
  },
): Promise<boolean> {
  const record = Schema.decodeUnknownSync(MemoryIndexVerificationPassRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.previous?.data.createdAt ?? input.now,
        cutoff: input.progress.cutoff,
        environmentId: input.scope.environmentId,
        indexStatus: input.progress.indexStatus,
        organizationId: input.scope.organizationId,
        projectId: input.scope.projectId,
        ...(input.progress.resumeAfter ? { resumeAfter: input.progress.resumeAfter } : {}),
        targetId: input.targetId,
        updatedAt: input.now,
        version: input.previous ? input.previous.data.version + 1 : 0,
        ...(input.scope.workspaceId ? { workspaceId: input.scope.workspaceId } : {}),
      },
      itemType: "memory-index-verification-pass" as const,
    }),
  );
  try {
    await database.transactWrite([
      { kind: "put", ...(input.previous ? { previousRecord: input.previous } : {}), record },
    ]);
    return true;
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return false;
    throw cause;
  }
}
