import "@tanstack/react-start/server-only";
import type {
  AnnotationResponse,
  CreateAnnotationRequest,
  RecordScoreResultRequest,
  ScoreResultResponse,
} from "@deployments-ai/api-contract";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute, collectPages } from "./platform-api.ts";

const PAGE_LIMIT = 100;
/** A trace's footer shows at most this many pages of scores or annotations, newest first. */
const MAX_FEEDBACK_PAGES = 5;

/** One page-capped feedback list, newest first. */
export interface FeedbackList<Item> {
  readonly items: readonly Item[];
  readonly truncated: boolean;
}

/** A score definition as the trace footer names and records it. */
export interface ScoreDefinitionEntry {
  readonly description?: string;
  readonly evaluatorKind: string;
  readonly id: string;
  /** Labels a human score may carry; absent when any label is accepted. */
  readonly labels?: readonly string[];
  readonly name: string;
  /** Active human or imported definitions; the API rejects recorded scores for any other. */
  readonly recordable: boolean;
  readonly threshold: number;
}

async function newestPages<Item extends { readonly createdAt: string }>(
  fetchPage: (cursor: string | undefined) => Promise<{
    readonly items: readonly Item[];
    readonly nextCursor?: string | undefined;
  }>,
): Promise<FeedbackList<Item>> {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FEEDBACK_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return {
    items: items.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    truncated: cursor !== undefined,
  };
}

export function loadTraceScores(
  accessToken: string,
  scope: EnvironmentScope,
  traceId: string,
): Promise<FeedbackList<ScoreResultResponse>> {
  requirePublicIds({ ...scope });
  return newestPages((cursor) =>
    callRoute(
      "listTraceScoreResults",
      { path: { traceId }, query: { cursor, limit: PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export function loadTraceAnnotations(
  accessToken: string,
  scope: EnvironmentScope,
  traceId: string,
): Promise<FeedbackList<AnnotationResponse>> {
  requirePublicIds({ ...scope });
  return newestPages((cursor) =>
    callRoute(
      "listTraceAnnotations",
      { path: { traceId }, query: { cursor, limit: PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

/**
 * Every score definition (archived ones still name past results), with what recording a score
 * against each needs.
 */
export async function loadScoreDefinitionDirectory(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<ScoreDefinitionEntry[]> {
  requirePublicIds({ ...scope });
  const definitions = await collectPages((cursor) =>
    callRoute("listScoreDefinitions", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
  );
  return definitions
    .map(({ description, id, name, revision, status }) => {
      const { evaluator } = revision;
      return {
        ...(description === undefined ? {} : { description }),
        evaluatorKind: evaluator.kind,
        id,
        ...(evaluator.kind === "human" && evaluator.labels ? { labels: evaluator.labels } : {}),
        name,
        recordable:
          status === "active" && (evaluator.kind === "human" || evaluator.kind === "imported"),
        threshold: revision.threshold,
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function recordTraceScore(
  accessToken: string,
  scope: EnvironmentScope,
  traceId: string,
  body: RecordScoreResultRequest,
  idempotencyKey: string,
): Promise<ScoreResultResponse> {
  requirePublicIds({ ...scope });
  return callRoute(
    "recordTraceScoreResult",
    { body, idempotencyKey, path: { traceId }, scope },
    accessToken,
  );
}

export function createTraceAnnotation(
  accessToken: string,
  scope: EnvironmentScope,
  traceId: string,
  body: CreateAnnotationRequest,
  idempotencyKey: string,
): Promise<AnnotationResponse> {
  requirePublicIds({ ...scope });
  return callRoute(
    "createTraceAnnotation",
    { body, idempotencyKey, path: { traceId }, scope },
    accessToken,
  );
}
