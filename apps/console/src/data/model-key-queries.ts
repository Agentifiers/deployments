import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { loadModelKeys } from "../server/model-key-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { requireIds } from "./server-input.ts";

const fetchModelKeys = createServerFn({ method: "GET" })
  .validator((input: { readonly organizationId: string }) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) => loadModelKeys(await requireAccessToken(), data.organizationId));

export const modelKeysQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchModelKeys({ data: { organizationId } }),
    queryKey: ["model-keys", organizationId],
  });

export function invalidateModelKeys(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: ["model-keys", organizationId] });
}
