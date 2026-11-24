import type {
  BrainAskRequest,
  BrainAskResponse,
  BrainFeedbackResponse,
  BrainSearchRequest,
  BrainSearchResponse,
  RecordBrainFeedbackRequest,
} from "@deployments-ai/api-contract/brains";
import { PlatformApiError } from "../errors.ts";

export type BrainAnswer = typeof BrainAskResponse.Type;
export type BrainSearchResults = typeof BrainSearchResponse.Type;
export type BrainCitation = BrainAnswer["usedCitations"][number];
export type BrainSearchHit = BrainSearchResults["results"][number];
export type BrainFeedback = typeof BrainFeedbackResponse.Type;
export type Usefulness = RecordBrainFeedbackRequest["usefulness"];

export type SearchBody = typeof BrainSearchRequest.Encoded;
export type AskBody = typeof BrainAskRequest.Encoded;
export type FeedbackBody = typeof RecordBrainFeedbackRequest.Encoded;

export type BrainQueryMode = "ask" | "search";

export type BrainQueryResult =
  | { readonly mode: "ask"; readonly answer: BrainAnswer }
  | { readonly mode: "search"; readonly results: BrainSearchResults };

export const MAX_QUERY_BRAINS = 20;
export const MAX_QUERY_LENGTH = 8_000;
export const MAX_FEEDBACK_LENGTH = 2_000;

export const USEFULNESS = ["useful", "neutral", "harmful"] as const satisfies readonly Usefulness[];

export const QUERY_COST: Readonly<Record<BrainQueryMode, string>> = {
  ask: "Asking embeds the question with one model call, then makes up to two answer-model calls. It counts one Brain retrieval in this environment's usage.",
  search:
    "Searching embeds the query with one model call. It counts one Brain retrieval in this environment's usage.",
};

export function citationKey(citation: BrainCitation): string {
  const { brainId, chunkId, documentId, documentVersionId, renditionId } = citation;
  return [brainId, documentId, documentVersionId, renditionId, chunkId].join(":");
}

export interface JoinedClaim {
  readonly citations: readonly { readonly citation: BrainCitation; readonly number: number }[];
  readonly text: string;
  readonly unresolved: readonly string[];
}

export function joinClaims(answer: BrainAnswer): readonly JoinedClaim[] {
  const numbered = new Map(
    answer.usedCitations.map((citation, index) => [
      citationKey(citation),
      { citation, number: index + 1 },
    ]),
  );
  return answer.claims.map((claim) => {
    const citations: JoinedClaim["citations"][number][] = [];
    const unresolved: string[] = [];
    for (const id of claim.citationIds) {
      const found = numbered.get(id);
      if (found) citations.push(found);
      else unresolved.push(id);
    }
    return { citations, text: claim.text, unresolved };
  });
}

/** A `?brainId=` the loaded list does not show has no checkbox, so it cannot count or be sent. */
export function chosenBrains(
  selected: readonly string[],
  loaded: ReadonlyMap<string, string>,
): readonly string[] {
  return selected.filter((id) => loaded.has(id));
}

export interface QuerySearch {
  readonly brainId?: string | undefined;
}

/** The router spreads the result over the raw search, so an invalid `brainId` is set to `undefined`. */
export function parseQuerySearch(search: Readonly<Record<string, unknown>>): QuerySearch {
  return { brainId: typeof search.brainId === "string" ? search.brainId : undefined };
}

/**
 * A missing Brain search placement fails search and ask with a bare 500 `internal_error`, which the
 * console cannot tell from a platform fault. A missing query runtime has its own code.
 */
export function searchNotEnabled(error: unknown): boolean {
  return (
    error instanceof PlatformApiError &&
    (error.operation === "searchBrains" || error.operation === "askBrains") &&
    error.problem.status === 500 &&
    error.problem.code !== "brain_search_unavailable"
  );
}
