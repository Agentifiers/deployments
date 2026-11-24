import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { requireAccessToken } from "../server/session.ts";
import { loadTenancyResource } from "../server/tenancy-settings-data.ts";
import {
  TENANCY_LEVELS,
  TENANCY_REF_IDS,
  tenancyResourceKey,
  type TenancyRef,
} from "../tenancy/settings.ts";
import { invalidateTenancy } from "./console-queries.ts";
import { fields, requireIds } from "./server-input.ts";

export function tenancyRefInput(input: unknown): TenancyRef {
  const ref = fields(input).ref;
  const level = oneOf(TENANCY_LEVELS, fields(ref).level);
  if (level === undefined)
    throw new TypeError(`level must be one of ${TENANCY_LEVELS.join(", ")}.`);
  return { ...requireIds(ref, TENANCY_REF_IDS[level]), level } as TenancyRef;
}

const fetchTenancyResource = createServerFn({ method: "GET" })
  .validator((input: { readonly ref: TenancyRef }) => ({ ref: tenancyRefInput(input) }))
  .handler(async ({ data }) => loadTenancyResource(await requireAccessToken(), data.ref));

export const tenancyResourceQuery = (ref: TenancyRef) =>
  queryOptions({
    queryFn: () => fetchTenancyResource({ data: { ref } }),
    queryKey: tenancyResourceKey(ref),
  });

/** Names and statuses also show in the shell, the switcher, and the workspace list. */
export function invalidateTenancySettings(queryClient: QueryClient, ref: TenancyRef) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: tenancyResourceKey(ref) }),
    invalidateTenancy(queryClient),
    queryClient.invalidateQueries({ queryKey: ["environment"] }),
    queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
  ]);
}
