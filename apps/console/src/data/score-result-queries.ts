import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  addTraceToDataset,
  archiveScoreDefinition,
  loadScoreResultPage,
} from "../server/score-result-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInput, pageInput, type KeyedInput, type PageInput } from "./server-input.ts";

const OBSERVABILITY_IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/u;

const fetchScoreResultPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly scoreDefinitionId: string }) =>
    pageInput(input, ["scoreDefinitionId"]),
  )
  .handler(async ({ data }) =>
    loadScoreResultPage(
      await requireAccessToken(),
      data.scope,
      data.scoreDefinitionId,
      data.cursor,
    ),
  );

export const archiveScoreDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly scoreDefinitionId: string }) =>
    keyedInput(input, ["scoreDefinitionId"]),
  )
  .handler(async ({ data }) =>
    archiveScoreDefinition(
      await requireAccessToken(),
      data.scope,
      data.scoreDefinitionId,
      data.idempotencyKey,
    ),
  );

export const addTraceToDatasetFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly datasetId: string; readonly traceId: string }) => {
    const { traceId } = fields(input);
    if (typeof traceId !== "string" || !OBSERVABILITY_IDENTIFIER.test(traceId)) {
      throw new TypeError("traceId must be an observability identifier.");
    }
    return { ...keyedInput(input, ["datasetId"]), traceId };
  })
  .handler(async ({ data }) =>
    addTraceToDataset(
      await requireAccessToken(),
      data.scope,
      data.datasetId,
      data.traceId,
      data.idempotencyKey,
    ),
  );

/** Under the evaluations prefix, so `invalidateEvaluations` refreshes it after a mutation. */
export const scoreResultPagesQuery = (scope: EnvironmentScope, scoreDefinitionId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchScoreResultPage({
        data: {
          scope,
          scoreDefinitionId,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["evaluations", ...scopeKey(scope), "score-results", scoreDefinitionId],
  });
