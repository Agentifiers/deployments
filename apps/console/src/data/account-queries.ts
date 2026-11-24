import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  loadAccountProfile,
  loadAccountSecurity,
  loadAccountSessionPage,
} from "../server/account-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields } from "./server-input.ts";

const MAX_CURSOR_LENGTH = 256;

const fetchAccountSecurity = createServerFn({ method: "GET" }).handler(async () =>
  loadAccountSecurity(await requireAccessToken()),
);

const fetchAccountSessionPage = createServerFn({ method: "GET" })
  .validator((input: { readonly cursor?: string }) => {
    const { cursor } = fields(input);
    if (cursor === undefined) return {};
    if (typeof cursor !== "string" || !cursor || cursor.length > MAX_CURSOR_LENGTH) {
      throw new TypeError("cursor must be a non-empty string of at most 256 characters.");
    }
    return { cursor };
  })
  .handler(async ({ data }) => loadAccountSessionPage(await requireAccessToken(), data.cursor));

export const accountSecurityQuery = () =>
  queryOptions({ queryFn: () => fetchAccountSecurity(), queryKey: ["account", "security"] });

const fetchAccountProfile = createServerFn({ method: "GET" }).handler(async () =>
  loadAccountProfile(await requireAccessToken()),
);

export const accountProfileQuery = () =>
  queryOptions({ queryFn: () => fetchAccountProfile(), queryKey: ["account", "profile"] });

export const accountSessionsQuery = () =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchAccountSessionPage({ data: pageParam === undefined ? {} : { cursor: pageParam } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["account", "sessions"],
  });

export function invalidateAccount(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ["account"] });
}
