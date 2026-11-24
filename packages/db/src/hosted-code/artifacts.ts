import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { HostedCodeArtifactRecord } from "../records/hosted-code.ts";
import { RecordDecodeError, withCanonicalRecordKeys } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export type HostedCodeArtifact = typeof HostedCodeArtifactRecord.Type;
export type HostedCodeArtifactData = HostedCodeArtifact["data"];

export interface HostedCodeArtifactKey {
  readonly contentHash: string;
  readonly environmentId: string;
  readonly organizationId: string;
}

/** A different artifact already owns this content hash in the environment. */
export class HostedCodeArtifactConflictError extends Schema.TaggedErrorClass<HostedCodeArtifactConflictError>()(
  "HostedCodeArtifactConflictError",
  { message: Schema.String },
) {}

export interface HostedCodeArtifactPersistence {
  /**
   * Create-only and content addressed: re-uploading identical executable bytes returns the
   * existing immutable record instead of writing a second one.
   */
  readonly create: (data: Omit<HostedCodeArtifactData, "version">) => Promise<HostedCodeArtifact>;
  readonly load: (artifact: HostedCodeArtifactKey) => Promise<HostedCodeArtifact | undefined>;
}

export function hostedCodeArtifactRecordKey(artifact: HostedCodeArtifactKey) {
  return {
    pk: key("ORG", artifact.organizationId, "ENV", artifact.environmentId),
    sk: key("HOSTED-CODE-ARTIFACT", artifact.contentHash.replace(/^sha256:/u, "")),
  };
}

export function makeHostedCodeArtifactPersistence(
  database: DynamoDatabaseService,
): HostedCodeArtifactPersistence {
  const load: HostedCodeArtifactPersistence["load"] = async (artifact) => {
    const record = await database.getRecord("control", hostedCodeArtifactRecordKey(artifact), true);
    if (!record || record.itemType === "hosted-code-artifact") return record;
    throw new RecordDecodeError({
      cause: record.itemType,
      message: "Hosted code artifact key contains an unexpected record.",
    });
  };
  return {
    create: async (data) => {
      let record: HostedCodeArtifact;
      try {
        record = Schema.decodeUnknownSync(HostedCodeArtifactRecord, { onExcessProperty: "error" })(
          withCanonicalRecordKeys({
            data: { ...data, version: 0 },
            itemType: "hosted-code-artifact" as const,
          }),
        );
      } catch (cause) {
        throw new RecordDecodeError({ cause, message: "Hosted code artifact record is invalid." });
      }
      try {
        await database.transactWrite([{ kind: "put", record }]);
        return record;
      } catch (failure) {
        if (!isDatabaseWriteConflict(failure)) throw failure;
        const existing = await load(record.data);
        if (!existing) throw failure;
        if (
          existing.data.language !== record.data.language ||
          existing.data.sourceLanguage !== record.data.sourceLanguage ||
          existing.data.projectId !== record.data.projectId
        ) {
          throw new HostedCodeArtifactConflictError({
            message:
              "Another hosted code artifact with this content hash uses a different language.",
          });
        }
        return existing;
      }
    },
    load,
  };
}
