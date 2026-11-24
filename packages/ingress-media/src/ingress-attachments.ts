import {
  INPUT_MEDIA_SIGNATURE_BYTES,
  MAX_INPUT_ARTIFACT_BYTES,
} from "@deployments-ai/agent-manifest";
import {
  deterministicUlid,
  ingressAttachmentObjectKey,
  makeIngressInputArtifactPersistence,
  RecordDecodeError,
  sameArtifactOwner,
  type ArtifactInputFile,
  type DynamoDatabaseService,
  type IngressInputArtifact,
  type IngressInputArtifactScope,
  type IngressSource,
  type Ulid,
} from "@deployments-ai/db";
import {
  ExtractionUnavailableError,
  prepareInputFile,
  type FileTextExtractor,
  type InputFileSource,
} from "@deployments-ai/file-text";
import { createHash } from "node:crypto";
import type { IngressAttachmentObjectStore } from "./attachment-object.ts";
import {
  selectIngressAttachments,
  type IngressAttachmentCandidate,
  type IngressAttachmentIdentity,
  type IngressAttachmentOffer,
  type IngressSkippedAttachment,
} from "./attachment-selection.ts";

export const INGRESS_ATTACHMENT_READ_TIMEOUT_MS = 10_000;
export const INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS = 20_000;
export const INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS = 45_000;
export const INGRESS_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PENDING_CAPTURE_TTL_MS = 24 * 60 * 60 * 1_000;
const ARTIFACT_ID_SEED = "ingress-attachment/v1";

export interface IngressAttachmentsRequest<Reference> {
  readonly candidates: readonly IngressAttachmentCandidate<Reference>[];
  readonly capture: boolean;
  readonly owner: IngressSource;
  readonly scope: IngressInputArtifactScope;
  readonly threadId: Ulid;
}

export type IngressAttachmentReader<Reference> = (
  reference: Reference,
  limits: { readonly maxBytes: number; readonly signal: AbortSignal },
) => Promise<Uint8Array>;

export class IngressAttachmentReadError extends Error {
  constructor(
    readonly kind: "permanent" | "transient",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IngressAttachmentReadError";
  }
}

export interface IngressAttachmentsDependencies<Reference> {
  readonly artifactBucket: string;
  readonly database: DynamoDatabaseService;
  readonly extractor: FileTextExtractor;
  readonly now?: () => Date;
  readonly onTransientFailure: "omit" | "throw";
  readonly openObjectStore: (
    scope: IngressInputArtifactScope,
  ) => Promise<IngressAttachmentObjectStore>;
  readonly openReader: (source: {
    readonly owner: IngressSource;
    readonly scope: IngressInputArtifactScope;
  }) => Promise<IngressAttachmentReader<Reference>>;
}

type TransientOmission =
  | "budget_exhausted"
  | "extraction_unavailable"
  | "store_failed"
  | "unavailable";
type PermanentOmission = "artifact_unusable" | "source_changed" | "too_large" | "unreadable";
export type IngressAttachmentOmission = PermanentOmission | TransientOmission;

export interface IngressAttachmentsResult {
  readonly offeredArtifactIds: readonly Ulid[];
  readonly omitted: readonly {
    readonly artifactId: Ulid;
    readonly reason: IngressAttachmentOmission;
  }[];
  readonly skipped: readonly IngressSkippedAttachment[];
}

export interface IngressAttachments<Reference> {
  prepare(request: IngressAttachmentsRequest<Reference>): Promise<IngressAttachmentsResult>;
}

type CaptureOutcome =
  | { readonly status: "available" }
  | { readonly reason: PermanentOmission; readonly status: "omitted" }
  | { readonly cause: unknown; readonly reason: TransientOmission; readonly status: "failed" };

interface StoredSource {
  readonly head: Uint8Array;
  readonly objects: IngressAttachmentObjectStore;
  readonly pending: IngressInputArtifact;
  readonly source: InputFileSource;
  readonly stored: { readonly etag?: string; readonly versionId: string };
}

type CapturePlan =
  | { readonly action: "create" }
  | { readonly action: "resume"; readonly pending: IngressInputArtifact }
  | { readonly action: "reuse" }
  | { readonly action: "skip" };

function artifactId(
  request: IngressAttachmentsRequest<unknown>,
  identity: IngressAttachmentIdentity,
) {
  const source = [
    ARTIFACT_ID_SEED,
    request.scope.organizationId,
    request.scope.environmentId,
    request.owner.sourceKind,
    request.owner.sourceId,
    request.threadId,
  ];
  switch (identity.type) {
    case "channel-attachment":
      return deterministicUlid(
        JSON.stringify([...source, identity.externalMessageId, identity.ordinal]),
      );
    case "email-attachment":
      return deterministicUlid(JSON.stringify([...source, identity.emailAttachmentId]));
    default: {
      const unhandled: never = identity;
      return unhandled;
    }
  }
}

function expired(expiresAt: string | undefined, now: Date) {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

function capturePlan(
  existing: IngressInputArtifact | undefined,
  request: IngressAttachmentsRequest<unknown>,
  now: Date,
): CapturePlan {
  if (!existing) return { action: "create" };
  if (
    !sameArtifactOwner(existing.data.owner, request.owner) ||
    existing.data.threadId !== request.threadId
  ) {
    return { action: "skip" };
  }
  switch (existing.data.status) {
    case "available":
      return expired(existing.data.retentionExpiresAt, now)
        ? { action: "skip" }
        : { action: "reuse" };
    case "pending":
      return expired(existing.data.uploadExpiresAt, now)
        ? { action: "skip" }
        : { action: "resume", pending: existing };
    case "deleted":
    case "failed":
      return { action: "skip" };
    default: {
      const unhandled: never = existing.data.status;
      return unhandled;
    }
  }
}

export function makeIngressAttachments<Reference>(
  dependencies: IngressAttachmentsDependencies<Reference>,
): IngressAttachments<Reference> {
  const persistence = makeIngressInputArtifactPersistence(dependencies.database);

  return {
    async prepare(request) {
      const { offered, skipped } = selectIngressAttachments(request.candidates);
      const offers = offered.map((offer) => ({
        artifactId: artifactId(request, offer.candidate.identity),
        offer,
      }));
      const offeredArtifactIds = offers.map((offer) => offer.artifactId);
      if (!request.capture) return { offeredArtifactIds, omitted: [], skipped };

      const now = dependencies.now?.() ?? new Date();
      const budgetEndsAt = Date.now() + INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS;
      const budget = AbortSignal.timeout(INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS);
      let reader: Promise<IngressAttachmentReader<Reference>> | undefined;
      let objectStore: Promise<IngressAttachmentObjectStore> | undefined;

      async function store(
        id: Ulid,
        { candidate, name }: IngressAttachmentOffer<Reference>,
      ): Promise<CaptureOutcome | { readonly file: StoredSource; readonly status: "stored" }> {
        const plan = capturePlan(await persistence.find(request.scope, id), request, now);
        if (plan.action === "reuse") return { status: "available" };
        if (plan.action === "skip") return { reason: "artifact_unusable", status: "omitted" };
        if (budget.aborted) {
          return { cause: budget.reason, reason: "budget_exhausted", status: "failed" };
        }

        let bytes: Uint8Array;
        try {
          reader ??= dependencies.openReader({ owner: request.owner, scope: request.scope });
          const read = await reader;
          bytes = await read(candidate.reference, {
            maxBytes: MAX_INPUT_ARTIFACT_BYTES,
            signal: AbortSignal.any([
              budget,
              AbortSignal.timeout(INGRESS_ATTACHMENT_READ_TIMEOUT_MS),
            ]),
          });
        } catch (cause) {
          if (cause instanceof IngressAttachmentReadError && cause.kind === "permanent") {
            return { reason: "unreadable", status: "omitted" };
          }
          return {
            cause,
            reason: budget.aborted ? "budget_exhausted" : "unavailable",
            status: "failed",
          };
        }
        if (bytes.byteLength > MAX_INPUT_ARTIFACT_BYTES) {
          return { reason: "too_large", status: "omitted" };
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const pending =
          plan.action === "resume"
            ? plan.pending
            : await persistence.createPending({
                artifactId: id,
                name,
                now,
                owner: request.owner,
                scope: request.scope,
                storage: {
                  bucket: dependencies.artifactBucket,
                  byteSize: bytes.byteLength,
                  sha256,
                },
                threadId: request.threadId,
                uploadExpiresAt: new Date(now.getTime() + PENDING_CAPTURE_TTL_MS),
              });
        if (pending.data.status === "available") return { status: "available" };
        if (pending.data.status !== "pending") {
          return { reason: "artifact_unusable", status: "omitted" };
        }
        const key = ingressAttachmentObjectKey(request.scope, id, sha256);
        if (pending.data.storage.key !== key) {
          return { reason: "source_changed", status: "omitted" };
        }

        objectStore ??= dependencies.openObjectStore(request.scope);
        const objects = await objectStore;
        const stored = await objects.putSourceOnce({
          bucket: dependencies.artifactBucket,
          bytes,
          contentType: pending.data.storage.contentType,
          key,
          metadata: {
            artifactId: id,
            environmentId: request.scope.environmentId,
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            sha256,
          },
          sha256,
        });
        const { contentType } = candidate.declared;
        return {
          file: {
            head: bytes.slice(0, INPUT_MEDIA_SIGNATURE_BYTES),
            objects,
            pending,
            source: {
              artifactId: id,
              bucket: dependencies.artifactBucket,
              byteSize: bytes.byteLength,
              hint: { ...(contentType === undefined ? {} : { contentType }), fileName: name },
              key,
              scope: request.scope,
              sha256,
              versionId: stored.versionId,
            },
            stored,
          },
          status: "stored",
        };
      }

      async function resolve({
        head,
        objects,
        pending,
        source,
        stored,
      }: StoredSource): Promise<CaptureOutcome> {
        const deadlineMs = Math.min(
          INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS,
          budgetEndsAt - Date.now(),
        );
        const deadlineShortened = deadlineMs < INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS;
        let input: ArtifactInputFile;
        try {
          input = await prepareInputFile(source, {
            deadlineMs,
            extractor: dependencies.extractor,
            objects: {
              presignSource: (file) => objects.presignSource(file),
              putTextOnce: (text) => objects.putTextOnce(text),
              readLeadingBytes: async () => head,
            },
            signal: budget,
          });
        } catch (cause) {
          if (!(cause instanceof ExtractionUnavailableError)) {
            return { cause, reason: "store_failed", status: "failed" };
          }
          return {
            cause,
            reason: budget.aborted ? "budget_exhausted" : "extraction_unavailable",
            status: "failed",
          };
        }
        if (input.kind === "unusable" && input.reason === "limits_exceeded" && deadlineShortened) {
          return {
            cause: new Error(
              `Extraction hit a limit under a ${deadlineMs} ms deadline cut short by the capture budget.`,
            ),
            reason: "budget_exhausted",
            status: "failed",
          };
        }
        await persistence.markAvailable(pending, {
          ...(stored.etag ? { etag: stored.etag } : {}),
          input,
          now,
          retentionExpiresAt: new Date(now.getTime() + INGRESS_ATTACHMENT_RETENTION_MS),
          versionId: stored.versionId,
        });
        return { status: "available" };
      }

      const failure = (cause: unknown): CaptureOutcome =>
        cause instanceof RecordDecodeError
          ? { reason: "artifact_unusable", status: "omitted" }
          : { cause, reason: "store_failed", status: "failed" };
      const captures: Promise<{ readonly artifactId: Ulid; readonly outcome: CaptureOutcome }>[] =
        [];
      for (const { artifactId: id, offer } of offers) {
        const first = await store(id, offer).catch(failure);
        const outcome =
          first.status === "stored" ? resolve(first.file).catch(failure) : Promise.resolve(first);
        captures.push(outcome.then((settled) => ({ artifactId: id, outcome: settled })));
      }

      const omitted: { artifactId: Ulid; reason: IngressAttachmentOmission }[] = [];
      for (const { artifactId: id, outcome } of await Promise.all(captures)) {
        if (outcome.status === "available") continue;
        if (outcome.status === "failed" && dependencies.onTransientFailure === "throw") {
          throw outcome.cause;
        }
        omitted.push({ artifactId: id, reason: outcome.reason });
      }
      return { offeredArtifactIds, omitted, skipped };
    },
  };
}
