import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { loadDirectory } from "../server/directory-sync-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { pageInputAt, type PageInputAt } from "./server-input.ts";

const fetchDirectory = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) => loadDirectory(await requireAccessToken(), data.scope));

const directoryKey = (organizationId: string) =>
  ["sign-in", organizationId, "directory-sync"] as const;

export function invalidateDirectory(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: directoryKey(organizationId) });
}

export const directoryQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchDirectory({ data: { scope: { organizationId } } }),
    queryKey: directoryKey(organizationId),
  });
