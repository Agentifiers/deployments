import { BrainAnswerInvalidError, type BrainAnswerRejection } from "./errors.ts";
import type { BrainSearchResult } from "./search.ts";

/** One primary attempt plus one same-model recovery attempt, mirroring the agent runtime. */
export const BRAIN_ANSWER_ATTEMPTS = 2;

export interface BrainAnswerClaim {
  readonly citationIds: readonly string[];
  readonly text: string;
}

export interface BrainAnswer {
  readonly claims: readonly BrainAnswerClaim[];
  readonly gaps: readonly string[];
  readonly usedCitations: readonly BrainSearchResult["citation"][];
}

export interface BrainModelUsageScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workspaceId: string | undefined;
}

export interface BrainAnswerModel {
  readonly synthesize: (input: {
    readonly evidence: readonly {
      readonly citationId: string;
      readonly excerpt: string;
      readonly title?: string;
    }[];
    readonly organizationId?: string;
    readonly question: string;
    /** Set on the deliberate retry after a rejected answer; the adapter adds recovery framing. */
    readonly recovery?: "same-model-retry";
    readonly signal?: AbortSignal;
    readonly usageOperationId: string;
    readonly usageScope?: BrainModelUsageScope;
  }) => Promise<{
    readonly claims: readonly BrainAnswerClaim[];
    readonly gaps: readonly string[];
  }>;
}

function citationId(result: BrainSearchResult) {
  const citation = result.citation;
  return [
    citation.brainId,
    citation.documentId,
    citation.documentVersionId,
    citation.renditionId,
    citation.chunkId,
  ].join(":");
}

export interface BrainAnswerRejectionEvent {
  readonly attempt: number;
  readonly final: boolean;
  readonly rejection: BrainAnswerRejection;
}

export async function askBrain(input: {
  readonly authorizeDisclosure: (evidence: BrainSearchResult) => Promise<boolean>;
  readonly evidence: readonly BrainSearchResult[];
  readonly model: BrainAnswerModel;
  readonly onAnswerRejected?: (event: BrainAnswerRejectionEvent) => void;
  readonly organizationId?: string;
  readonly question: string;
  readonly signal?: AbortSignal;
  readonly usageOperationId: string;
  readonly usageScope?: BrainModelUsageScope;
}): Promise<BrainAnswer> {
  const citations = new Map(input.evidence.map((result) => [citationId(result), result]));
  const evidence = input.evidence.map((result) => ({
    citationId: citationId(result),
    excerpt: result.excerpt,
    ...(result.title ? { title: result.title } : {}),
  }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const synthesized = await input.model.synthesize({
        evidence,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        question: input.question,
        ...(attempt > 0 ? { recovery: "same-model-retry" as const } : {}),
        usageOperationId: input.usageOperationId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.usageScope ? { usageScope: input.usageScope } : {}),
      });
      const used = new Set<string>();
      for (const claim of synthesized.claims) {
        if (claim.citationIds.length === 0) throw new BrainAnswerInvalidError("uncited-claim");
        for (const id of claim.citationIds) {
          if (!citations.has(id)) throw new BrainAnswerInvalidError("citation-outside-context");
          used.add(id);
        }
      }
      for (const id of used) {
        const result = citations.get(id)!;
        if (!(await input.authorizeDisclosure(result))) {
          throw new Error("Brain answer authorization changed before disclosure.");
        }
      }
      return {
        claims: synthesized.claims,
        gaps: synthesized.gaps,
        usedCitations: [...used].map((id) => citations.get(id)!.citation),
      };
    } catch (cause) {
      if (!(cause instanceof BrainAnswerInvalidError)) throw cause;
      const final = attempt + 1 >= BRAIN_ANSWER_ATTEMPTS;
      input.onAnswerRejected?.({ attempt, final, rejection: cause.rejection });
      if (final) throw cause;
    }
  }
}
