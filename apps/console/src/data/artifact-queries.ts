import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { PREVIEW_TEXT_BYTES } from "../artifacts/preview.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadArtifactText } from "../server/artifact-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { scopedInput, type ScopedInput } from "./server-input.ts";

const fetchArtifactText = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly artifactId: string }) =>
    scopedInput(input, ["artifactId"]),
  )
  .handler(async ({ data }) =>
    loadArtifactText(await requireAccessToken(), data.scope, data.artifactId, PREVIEW_TEXT_BYTES),
  );

/** The first bytes of a text artifact. Stored bytes never change, so one read serves the page. */
export const artifactTextQuery = (scope: EnvironmentScope, artifactId: string) =>
  queryOptions({
    queryFn: () => fetchArtifactText({ data: { artifactId, scope } }),
    queryKey: ["artifact-text", ...scopeKey(scope), artifactId],
    staleTime: Infinity,
  });
