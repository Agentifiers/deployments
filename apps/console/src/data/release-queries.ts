import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SCOPE_FIELDS, type EnvironmentScope } from "../scope.ts";
import { loadAgentRelease } from "../server/release-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { agentKey } from "./agent-queries.ts";
import { requireIds } from "./server-input.ts";

const fetchAgentRelease = createServerFn({ method: "GET" })
  .validator((input: { readonly releaseId: string; readonly scope: EnvironmentScope }) => {
    const record = input as { readonly scope?: unknown };
    return {
      ...requireIds(input, ["releaseId"]),
      scope: requireIds(record.scope, SCOPE_FIELDS),
    };
  })
  .handler(async ({ data }) =>
    loadAgentRelease(await requireAccessToken(), data.scope, data.releaseId),
  );

/**
 * One release of the agent with its manifest. Kept under the agent's key so agent mutations
 * (which can archive releases) refresh it; the manifest itself never changes.
 */
export const agentReleaseQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  releaseId: string,
) =>
  queryOptions({
    queryFn: () => fetchAgentRelease({ data: { releaseId, scope } }),
    queryKey: [...agentKey(scope, definitionId), "release", releaseId],
  });
