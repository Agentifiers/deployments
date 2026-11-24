import type {
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
} from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { organizationGateCheck } from "../organization-gate/requirements.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import type { BrainSearchTarget } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { brainUlid } from "./record-mapping.ts";
import { createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function targetQualifiedJobId(eventId: string, targetId: string) {
  let value = BigInt(`0x${createHash("sha256").update(`${eventId}\0${targetId}`).digest("hex")}`);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return brainUlid(`${eventId.slice(0, 10)}${suffix}`);
}

export async function brainIndexEnqueueOperations(
  database: DynamoDatabaseService,
  input: {
    readonly document: BrainDocument;
    readonly eventId: string;
    readonly indexEvidence?: {
      readonly rendition: BrainDocumentRendition;
      readonly version: BrainDocumentVersion;
    };
    readonly rendition?: BrainDocumentRendition;
    readonly version: BrainDocumentVersion;
    readonly migrationTarget?: BrainSearchTarget;
  },
): Promise<readonly TransactionOperation[]> {
  const operation = input.document.lifecycle === "active" ? "index" : "suppress";
  const evidenceVersion = input.indexEvidence?.version ?? input.version;
  const evidenceRendition = input.indexEvidence?.rendition ?? input.rendition;
  if (
    operation === "index"
      ? input.document.currentContentVersionId !== evidenceVersion.id || !evidenceRendition
      : input.document.currentVersionId !== input.version.id
  ) {
    return [];
  }
  const placement = await database.getRecord(
    "control",
    {
      pk: key("ORG", input.document.organizationId),
      sk: key("BRAIN-SEARCH-PLACEMENT", input.document.organizationId),
    },
    true,
  );
  if (
    placement?.itemType !== "brain-search-placement" ||
    placement.data.phase !== "active" ||
    !placement.data.writeTarget
  ) {
    return [];
  }
  const writeTarget = placement.data.writeTarget;
  const candidateTarget = placement.data.candidateTarget;
  if (
    input.migrationTarget &&
    (!candidateTarget ||
      candidateTarget.targetId !== input.migrationTarget.targetId ||
      !placement.data.operationId)
  )
    return [];
  const targets = input.migrationTarget
    ? [candidateTarget!]
    : [writeTarget, ...(candidateTarget ? [candidateTarget] : [])];
  const jobs = targets.map((target) =>
    Schema.decodeUnknownSync(BrainIndexJobRecord)(
      withCanonicalRecordKeys({
        data: {
          attempt: 0,
          brainId: brainUlid(input.document.brainId),
          components: target.components.map((component) => ({
            ...component,
            status: "pending" as const,
          })),
          createdAt: input.version.createdAt,
          documentId: brainUlid(input.document.id),
          documentVersionId: brainUlid(evidenceVersion.id),
          embeddingProfileId: target.embeddingProfileId,
          ...(evidenceVersion.contentHash
            ? { expectedContentHash: evidenceVersion.contentHash }
            : {}),
          expectedProjectionGeneration: input.document.projectionGeneration,
          id:
            target.targetId === writeTarget.targetId
              ? brainUlid(input.eventId)
              : targetQualifiedJobId(input.eventId, target.targetId),
          idempotencyKey: `${input.document.id}:${input.document.projectionGeneration}:${operation}${
            target.targetId === writeTarget.targetId ? "" : `:${target.targetId}`
          }`,
          nextDueAt: input.version.createdAt,
          operation,
          organizationId: brainUlid(input.document.organizationId),
          placementGeneration: placement.data.generation,
          priority: operation === "suppress" ? 0 : 100,
          provider: target.providerId,
          ...(evidenceRendition ? { renditionId: brainUlid(evidenceRendition.id) } : {}),
          schemaGeneration: target.schemaGeneration,
          sourceId: brainUlid(input.document.sourceId),
          status: "queued" as const,
          targetId: target.targetId,
          updatedAt: input.version.createdAt,
          version: 0,
        },
        itemType: "brain-index-job" as const,
      }),
    ),
  );
  return [
    organizationGateCheck(input.document.organizationId, {
      generation: placement.data.generation,
      kind: "brain-search-placement-active",
      version: placement.data.version,
    }),
    ...jobs.map((job) => ({
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put" as const,
      record: job,
    })),
  ];
}
