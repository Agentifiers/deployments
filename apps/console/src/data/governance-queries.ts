import {
  infiniteQueryOptions,
  queryOptions,
  type FetchQueryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { ErasureState } from "../governance/erasure-state.ts";
import { EXPORT_KINDS, isInFlight, type ExportKind } from "../governance/operation-state.ts";
import { oneOf } from "../observability/range.ts";
import {
  loadEgressAllowlist,
  loadErasure,
  loadExport,
  loadOrganizationErasure,
  loadOperationPage,
  loadRetentionPolicy,
} from "../server/governance-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { sleep } from "../sleep.ts";
import { IN_FLIGHT_REFRESH_MS } from "./refresh.ts";
import { fields, pageInputAt, requireIds, type PageInputAt } from "./server-input.ts";

interface OperationInput {
  readonly operationId: string;
  readonly organizationId: string;
}

export function exportKindInput(input: unknown): ExportKind {
  const kind = oneOf(EXPORT_KINDS, fields(input).kind);
  if (!kind) throw new TypeError("kind must be tenant-export or audit-export.");
  return kind;
}

const fetchRetentionPolicy = createServerFn({ method: "GET" })
  .validator((input: { readonly organizationId: string }) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    loadRetentionPolicy(await requireAccessToken(), data.organizationId),
  );

const fetchEgressAllowlist = createServerFn({ method: "GET" })
  .validator((input: { readonly organizationId: string }) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    loadEgressAllowlist(await requireAccessToken(), data.organizationId),
  );

const fetchOperationPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) =>
    loadOperationPage(await requireAccessToken(), data.scope.organizationId, data.cursor),
  );

const fetchExport = createServerFn({ method: "GET" })
  .validator((input: OperationInput & { readonly kind: ExportKind }) => ({
    ...requireIds(input, ["operationId", "organizationId"]),
    kind: exportKindInput(input),
  }))
  .handler(async ({ data }) =>
    loadExport(await requireAccessToken(), data.organizationId, data.kind, data.operationId),
  );

const fetchOrganizationErasure = createServerFn({ method: "GET" })
  .validator((input: { readonly organizationId: string }) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) =>
    loadOrganizationErasure(await requireAccessToken(), data.organizationId),
  );

const fetchErasure = createServerFn({ method: "GET" })
  .validator((input: OperationInput) => requireIds(input, ["operationId", "organizationId"]))
  .handler(async ({ data }) =>
    loadErasure(await requireAccessToken(), data.organizationId, data.operationId),
  );

const governanceKey = (organizationId: string) => ["governance", organizationId] as const;

export const retentionPolicyQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchRetentionPolicy({ data: { organizationId } }),
    queryKey: [...governanceKey(organizationId), "retention"],
  });

export const egressAllowlistQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchEgressAllowlist({ data: { organizationId } }),
    queryKey: [...governanceKey(organizationId), "egress-allowlist"],
  });

export const operationPagesQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchOperationPage({
        data: {
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...governanceKey(organizationId), "operations"],
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.items.some((item) => isInFlight(item.phase.status)),
      )
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });

export const exportQuery = (organizationId: string, kind: ExportKind, operationId: string) =>
  queryOptions({
    queryFn: () => fetchExport({ data: { kind, operationId, organizationId } }),
    queryKey: [...governanceKey(organizationId), "export", kind, operationId],
    refetchInterval: (query) =>
      query.state.data && isInFlight(query.state.data.phase.status) ? IN_FLIGHT_REFRESH_MS : false,
  });

export const organizationErasureQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchOrganizationErasure({ data: { organizationId } }),
    queryKey: [...governanceKey(organizationId), "erasure"],
  });

export const erasureQuery = (organizationId: string, operationId: string) =>
  queryOptions({
    queryFn: () => fetchErasure({ data: { operationId, organizationId } }),
    queryKey: ["erasure", organizationId, operationId],
    refetchInterval: (query) =>
      query.state.data?.kind === "in_progress" ? IN_FLIGHT_REFRESH_MS : false,
  });

const RESUME_READS = 12;

/**
 * Resuming returns the failed operation unchanged until a worker picks the run up, so the page
 * reads it from the server again until it leaves `blocked`, then the in-progress refresh takes over.
 */
export async function untilResumed(
  queryClient: QueryClient,
  query: FetchQueryOptions<ErasureState, Error, ErasureState, string[]>,
  signal: AbortSignal,
  pause = (aborted: AbortSignal) => sleep(IN_FLIGHT_REFRESH_MS, aborted),
): Promise<void> {
  for (let read = 1; read <= RESUME_READS; read += 1) {
    await pause(signal);
    if (signal.aborted) return;
    const state = await queryClient.fetchQuery({ ...query, staleTime: 0 });
    if (state.kind !== "blocked") return;
  }
}

export function invalidateGovernance(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: governanceKey(organizationId) });
}
