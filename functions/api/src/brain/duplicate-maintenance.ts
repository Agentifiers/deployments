import { createHash } from "node:crypto";
import type { Brain, BrainRepository } from "@deployments-ai/brains";
import {
  activeBrainCondition,
  brainPlatformRecord,
  brainUlid,
  BrainReviewItemRecord,
  deterministicUlid,
  getBrainDuplicatePass,
  makeSemanticEventRecord,
  recordBrainDuplicatePass,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Schema } from "effect";

interface CurrentContent {
  readonly documentId: string;
  readonly versionId: string;
}

/**
 * The current content of every active document, and a fingerprint of it. Document versions are
 * immutable, so equal fingerprints mean equal content hashes and the same duplicate groups.
 */
async function currentContents(repository: BrainRepository, brain: Brain) {
  const contents: CurrentContent[] = [];
  const fingerprint = createHash("sha256");
  let cursor: string | undefined;
  do {
    const page = await repository.listDocuments(brain.organizationId, brain.id, {
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    for (const document of page.items) {
      if (document.lifecycle !== "active" || !document.currentContentVersionId) continue;
      contents.push({ documentId: document.id, versionId: document.currentContentVersionId });
      fingerprint.update(`${document.id}:${document.currentContentVersionId}\n`);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { contents, fingerprint: fingerprint.digest("hex") };
}

async function duplicateGroups(
  repository: BrainRepository,
  brain: Brain,
  contents: readonly CurrentContent[],
) {
  const contentByHash = new Map<string, CurrentContent[]>();
  for (let start = 0; start < contents.length; start += 100) {
    const batch = contents.slice(start, start + 100);
    const versions = await Promise.all(
      batch.map(({ documentId, versionId }) =>
        repository.getDocumentVersion(brain.organizationId, documentId, versionId),
      ),
    );
    for (const [index, content] of batch.entries()) {
      const contentHash = versions[index]?.contentHash;
      if (!contentHash) continue;
      const existing = contentByHash.get(contentHash);
      if (existing) existing.push(content);
      else contentByHash.set(contentHash, [content]);
    }
  }
  return [...contentByHash.entries()].filter(([, entries]) => entries.length > 1);
}

async function createReview(input: {
  readonly brain: Brain;
  readonly contentHash: string;
  readonly database: DynamoDatabaseService;
  readonly entries: readonly CurrentContent[];
  readonly generateId: () => Promise<string>;
  readonly now: string;
  readonly repository: BrainRepository;
}) {
  const documentIds = input.entries.map(({ documentId }) => documentId).sort();
  const reviewId = deterministicUlid(
    [input.brain.organizationId, input.brain.id, input.contentHash, ...documentIds].join("\0"),
  );
  if (await input.repository.getReviewItem(input.brain.organizationId, input.brain.id, reviewId)) {
    return false;
  }
  const record = Schema.decodeUnknownSync(BrainReviewItemRecord)(
    withCanonicalRecordKeys({
      data: {
        brainId: brainUlid(input.brain.id),
        createdAt: input.now,
        id: reviewId,
        kind: "duplicate-document" as const,
        organizationId: brainUlid(input.brain.organizationId),
        proposal: {
          contentHash: input.contentHash,
          documentIds,
          versionIds: input.entries.map(({ versionId }) => versionId).sort(),
        },
        reason: "Current authorized document renditions have identical content hashes.",
        status: "open" as const,
        updatedAt: input.now,
        version: 0,
      },
      itemType: "brain-review-item" as const,
    }),
  );
  try {
    await transactWithSemanticEvents(
      input.database,
      [activeBrainCondition(brainPlatformRecord(input.brain)), { kind: "put", record }],
      [
        makeSemanticEventRecord({
          aggregateId: reviewId,
          aggregateType: "brain-review-item",
          aggregateVersion: 1,
          eventId: brainUlid(await input.generateId()),
          eventType: "brain-review-item.proposed",
          occurredAt: input.now,
          organizationId: brainUlid(input.brain.organizationId),
          payload: {
            brainId: input.brain.id,
            documentCount: documentIds.length,
            kind: "duplicate-document",
            reviewItemId: reviewId,
          },
        }),
      ],
      reviewId,
    );
    return true;
  } catch (cause) {
    const existing = await input.repository.getReviewItem(
      input.brain.organizationId,
      input.brain.id,
      reviewId,
    );
    if (existing) return false;
    throw cause;
  }
}

export async function detectBrainDocumentDuplicates(input: {
  readonly brain: Brain;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly now: string;
  readonly repository: BrainRepository;
}) {
  if (input.brain.status !== "active") return { groups: 0, reviewsCreated: 0 };
  const previous = await getBrainDuplicatePass(
    input.database,
    input.brain.organizationId,
    input.brain.id,
  );
  const { contents, fingerprint } = await currentContents(input.repository, input.brain);
  if (previous?.data.contentFingerprint === fingerprint) {
    return { groups: previous.data.duplicateGroups, reviewsCreated: 0 };
  }
  const groups = await duplicateGroups(input.repository, input.brain, contents);
  let reviewsCreated = 0;
  for (const [contentHash, entries] of groups) {
    if (await createReview({ ...input, contentHash, entries })) reviewsCreated += 1;
  }
  await recordBrainDuplicatePass(input.database, {
    brain: input.brain,
    contentFingerprint: fingerprint,
    duplicateGroups: groups.length,
    now: input.now,
    previous,
  });
  return { groups: groups.length, reviewsCreated };
}
