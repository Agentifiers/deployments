import type {
  BrainDocumentResponse,
  BrainEntityEvidenceResponse,
  BrainIndexHealthPageResponse,
  BrainReviewItemResponse,
  CaptureBrainDocumentRequest,
  ResolveBrainReviewItemRequest,
} from "@deployments-ai/api-contract/brains";

export type BrainIndexHealth = BrainIndexHealthPageResponse["items"][number];

type DocumentVersion = BrainDocumentResponse["version"];

export interface BrainDocumentView {
  readonly document: BrainDocumentResponse["document"];
  readonly version: Omit<DocumentVersion, "bodyRef">;
}

export function documentView({ document, version }: BrainDocumentResponse): BrainDocumentView {
  const { bodyRef: _bodyRef, ...shown } = version;
  return { document, version: shown };
}

export type LifecycleKind = "archive" | "restore" | "tombstone";

export type CaptureBody = typeof CaptureBrainDocumentRequest.Encoded;

export function lifecycleKinds(document: BrainDocumentView["document"]): readonly LifecycleKind[] {
  const restorable = document.currentContentVersionId !== undefined;
  switch (document.lifecycle) {
    case "active":
      return ["archive", "tombstone"];
    case "archived":
      return restorable ? ["restore", "tombstone"] : ["tombstone"];
    case "deleted":
      return restorable ? ["restore"] : [];
  }
}

export function lifecycleCapture(
  document: BrainDocumentView["document"],
  kind: LifecycleKind,
): CaptureBody {
  const { currentContentVersionId, externalItemIdentity } = document;
  return kind === "restore" && currentContentVersionId !== undefined
    ? { externalItemIdentity, kind, restoredContentVersionId: currentContentVersionId }
    : { externalItemIdentity, kind };
}

export type ReviewProposal =
  | {
      readonly kind: "entity-merge";
      readonly aliases: readonly string[];
      readonly candidateEntityIds: readonly string[];
    }
  | { readonly kind: "duplicate-document"; readonly documentIds: readonly string[] }
  | { readonly kind: "other" };

type ReviewItemResponse = typeof BrainReviewItemResponse.Type;

export type BrainReviewItemView = Omit<ReviewItemResponse, "proposal"> & {
  readonly proposal: ReviewProposal;
};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function reviewItemView({ proposal, ...item }: ReviewItemResponse): BrainReviewItemView {
  switch (item.kind) {
    case "entity-merge":
      return {
        ...item,
        proposal: {
          aliases: strings(proposal.aliases),
          candidateEntityIds: strings(proposal.candidateEntityIds),
          kind: "entity-merge",
        },
      };
    case "duplicate-document":
      return {
        ...item,
        proposal: { documentIds: strings(proposal.documentIds), kind: "duplicate-document" },
      };
    case "contradiction":
    case "extraction":
    case "summary":
      return { ...item, proposal: { kind: "other" } };
  }
}

export type ReviewDecision = ResolveBrainReviewItemRequest["decision"];

export type ResolveBody = typeof ResolveBrainReviewItemRequest.Encoded;

/** The platform cannot record a decision on a duplicate-document item yet (plan §8.1). */
export function reviewDecisions(item: BrainReviewItemView): readonly ReviewDecision[] {
  switch (item.proposal.kind) {
    case "duplicate-document":
      return [];
    case "entity-merge":
      return item.proposal.candidateEntityIds.length >= 2
        ? ["merge", "approve", "reject"]
        : ["approve", "reject"];
    case "other":
      return ["approve", "reject"];
  }
}

export type ReviewResolution =
  | { readonly decision: "approve" | "reject" }
  | { readonly decision: "merge"; readonly targetEntityId: string };

export function resolveBody(item: BrainReviewItemView, resolution: ReviewResolution): ResolveBody {
  return resolution.decision === "merge"
    ? {
        decision: "merge",
        expectedVersion: item.version,
        targetEntityId: resolution.targetEntityId,
      }
    : { decision: resolution.decision, expectedVersion: item.version };
}

type Entity = BrainEntityEvidenceResponse["entity"];
type Edge = BrainEntityEvidenceResponse["edges"][number];

export interface BrainEntityView {
  readonly edges: readonly Omit<Edge, "evidence">[];
  readonly entity: Omit<Entity, "externalIdentifiers">;
}

export function entityView({ edges, entity }: BrainEntityEvidenceResponse): BrainEntityView {
  const { externalIdentifiers: _externalIdentifiers, ...shown } = entity;
  return { edges: edges.map(({ evidence: _evidence, ...edge }) => edge), entity: shown };
}
