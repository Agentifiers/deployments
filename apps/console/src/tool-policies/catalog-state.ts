import { TOOL_CATALOG_STATUS_FILTERS } from "@deployments-ai/api-contract/tool-catalog";
import { oneOf } from "../observability/range.ts";

export type CatalogStatus = (typeof TOOL_CATALOG_STATUS_FILTERS)[number];

export interface CatalogFilters {
  readonly prefix?: string;
  readonly providerKey?: string;
  readonly search?: string;
  readonly status?: CatalogStatus;
}

export interface CatalogSearch {
  readonly prefix?: string;
  readonly provider?: string;
  readonly search?: string;
  readonly status?: CatalogStatus;
  readonly tool?: string;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > limit ? undefined : trimmed;
}

export function parseCatalogSearch(search: Readonly<Record<string, unknown>>): CatalogSearch {
  const status = oneOf(TOOL_CATALOG_STATUS_FILTERS, search.status);
  const prefix = text(search.prefix, 128);
  const provider = text(search.provider, 128);
  const query = text(search.search, 100);
  const tool = text(search.tool, 128);
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(provider === undefined ? {} : { provider }),
    ...(query === undefined ? {} : { search: query }),
    ...(status === undefined || status === "active" ? {} : { status }),
    ...(tool === undefined ? {} : { tool }),
  };
}

export function catalogFilters({
  prefix,
  provider,
  search,
  status,
}: CatalogSearch): CatalogFilters {
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(provider === undefined ? {} : { providerKey: provider }),
    ...(search === undefined ? {} : { search }),
    ...(status === undefined ? {} : { status }),
  };
}
