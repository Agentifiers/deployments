import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseSecretSearch, type OwnerType } from "../secrets/secret-state.ts";
import { loadCredentialReferencePage } from "../server/credential-reference-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { fields, pageInput, type PageInput } from "./server-input.ts";

const fetchCredentialReferencePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly owner?: OwnerType }) => ({
    ...pageInput(input),
    ...parseSecretSearch(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadCredentialReferencePage(await requireAccessToken(), data.scope, data.owner, data.cursor),
  );

/** The API binds each cursor to the owner filter, so the filter is part of the key. */
export const credentialReferencesQuery = (scope: EnvironmentScope, owner: OwnerType | undefined) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchCredentialReferencePage({
        data: {
          scope,
          ...(owner === undefined ? {} : { owner }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["secrets", ...scopeKey(scope), owner ?? "all"],
  });
