import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import { loadOAuthApps } from "../server/oauth-app-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { scopedInput, type ScopedInput } from "./server-input.ts";

const fetchOAuthApps = createServerFn({ method: "GET" })
  .validator((input: ScopedInput) => scopedInput(input))
  .handler(async ({ data }) => loadOAuthApps(await requireAccessToken(), data.scope));

export const oauthAppsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchOAuthApps({ data: { scope } }),
    queryKey: ["oauth-apps", ...scopeKey(scope)],
  });
