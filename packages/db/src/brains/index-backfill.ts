import type { BrainRepository } from "@deployments-ai/brains";
import { createHash } from "node:crypto";
import type { DynamoDatabaseService } from "../client-types.ts";
import { brainIndexEnqueueOperations } from "./index-enqueue.ts";
import { brainUlid } from "./record-mapping.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAGE_SIZE = 100;

export type BrainIndexBackfillRepository = Pick<
  BrainRepository,
  "getDocumentRendition" | "getDocumentVersion" | "listByOrganization" | "listDocuments"
>;

/** The backfill job identity for one document projection on one target, stable across retries. */
function backfillEventId(documentId: string, projectionGeneration: number, targetId: string) {
  let value = BigInt(
    `0x${createHash("sha256")
      .update(`brain-index-backfill\0${documentId}\0${projectionGeneration}\0${targetId}`)
      .digest("hex")}`,
  );
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return brainUlid(`${documentId.slice(0, 10)}${suffix}`);
}

/**
 * Queues index jobs for every active Brain document stored before the organization's Brain
 * search placement became active, since captures only enqueue jobs while a placement is active.
 * Job identities derive from the document projection and target, so a rerun skips documents
 * already queued; a document that changed meanwhile was queued by its own capture. The index
 * dispatch sweep delivers the jobs to the index worker.
 */
export async function backfillBrainSearchIndex(input: {
  readonly database: DynamoDatabaseService;
  readonly organizationId: string;
  readonly repository: BrainIndexBackfillRepository;
  readonly targetId: string;
}) {
  let queued = 0;
  let brainCursor: string | undefined;
  do {
    const brains = await input.repository.listByOrganization(input.organizationId, {
      ...(brainCursor ? { cursor: brainCursor } : {}),
      limit: PAGE_SIZE,
    });
    for (const brain of brains.items) {
      let documentCursor: string | undefined;
      do {
        const documents = await input.repository.listDocuments(input.organizationId, brain.id, {
          ...(documentCursor ? { cursor: documentCursor } : {}),
          limit: PAGE_SIZE,
        });
        for (const document of documents.items) {
          if (document.lifecycle !== "active" || !document.currentContentVersionId) continue;
          const version = await input.repository.getDocumentVersion(
            input.organizationId,
            document.id,
            document.currentContentVersionId,
          );
          const rendition =
            version?.originalRenditionId &&
            (await input.repository.getDocumentRendition(
              input.organizationId,
              version.id,
              version.originalRenditionId,
            ));
          if (!version || !rendition) continue;
          const operations = await brainIndexEnqueueOperations(input.database, {
            document,
            eventId: backfillEventId(document.id, document.projectionGeneration, input.targetId),
            rendition,
            version,
          });
          const jobs = operations.flatMap((operation) =>
            operation.kind === "put" && operation.record.itemType === "brain-index-job"
              ? [operation.record]
              : [],
          );
          if (jobs.length === 0) continue;
          try {
            await input.database.transactWrite(operations);
            queued += 1;
          } catch (cause) {
            const existing = await Promise.all(
              jobs.map((job) =>
                input.database.getRecord("execution", { pk: job.pk, sk: job.sk }, true),
              ),
            );
            if (existing.some((record) => record === undefined)) throw cause;
          }
        }
        documentCursor = documents.nextCursor;
      } while (documentCursor);
    }
    brainCursor = brains.nextCursor;
  } while (brainCursor);
  return { queued };
}
