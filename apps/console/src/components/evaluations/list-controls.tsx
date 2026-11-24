import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { datasetDirectoryQuery } from "../../data/evaluation-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";

/** Dataset names by ID, from the environment's dataset directory. */
export function useDatasetNames(scope: EnvironmentScope) {
  const { data: datasets } = useSuspenseQuery(datasetDirectoryQuery(scope));
  return useMemo(() => new Map(datasets.map((dataset) => [dataset.id, dataset.name])), [datasets]);
}
