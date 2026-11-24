import { createServerFn } from "@tanstack/react-start";
import * as actions from "../server/evaluation-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface BodyMutationInput extends KeyedInput {
  /** Decoded against the operation's contract schema in the handler. */
  readonly body: unknown;
}

function bodyMutationInput<const Field extends string = never>(
  input: unknown,
  ids: readonly Field[] = [],
) {
  return { ...keyedInput(input, ids), body: requireBody(input) };
}

export const createRegressionDataset = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput) => bodyMutationInput(input))
  .handler(async ({ data }) =>
    actions.createRegressionDataset({ ...data, accessToken: await requireAccessToken() }),
  );

export const importDatasetCases = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput & { readonly datasetId: string }) =>
    bodyMutationInput(input, ["datasetId"]),
  )
  .handler(async ({ data }) =>
    actions.importDatasetCases({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveRegressionDataset = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly datasetId: string }) =>
    keyedInput(input, ["datasetId"]),
  )
  .handler(async ({ data }) =>
    actions.archiveRegressionDataset({ ...data, accessToken: await requireAccessToken() }),
  );

export const createScoreDefinition = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput) => bodyMutationInput(input))
  .handler(async ({ data }) =>
    actions.createScoreDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

export const reviseScoreDefinition = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput & { readonly scoreDefinitionId: string }) =>
    bodyMutationInput(input, ["scoreDefinitionId"]),
  )
  .handler(async ({ data }) =>
    actions.reviseScoreDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

export const createEvaluationRun = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput) => bodyMutationInput(input))
  .handler(async ({ data }) =>
    actions.createEvaluationRun({ ...data, accessToken: await requireAccessToken() }),
  );

export const createReleaseComparison = createServerFn({ method: "POST" })
  .validator((input: BodyMutationInput) => bodyMutationInput(input))
  .handler(async ({ data }) =>
    actions.createReleaseComparison({ ...data, accessToken: await requireAccessToken() }),
  );
