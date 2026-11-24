import {
  MODEL_GATEWAY_PROVIDERS,
  modelProviderForId,
  normalizeModelId,
  type ModelGatewayProvider,
} from "@deployments-ai/model-gateway";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import type {
  DataBoundaryProfile,
  OrganizationDataBoundary,
} from "../records/organization-standing.ts";
import { loadStanding } from "./stored-standing.ts";

/**
 * Where a tool can send organization data. `platform` stays in the platform or with the calling
 * member. `configured` reaches a destination an organization admin fixed. `public` reaches a
 * destination the tool input chooses, a sandbox with internet egress, or a publication.
 */
export const TOOL_EGRESS_CLASSES = ["platform", "configured", "public"] as const;
export type ToolEgress = (typeof TOOL_EGRESS_CLASSES)[number];

export interface DataBoundary {
  readonly profile: DataBoundaryProfile | "open";
  readonly egress: ReadonlySet<ToolEgress>;
  readonly modelProviders: ReadonlySet<ModelGatewayProvider>;
}

const DATA_BOUNDARY_PROFILES = {
  open: { egress: TOOL_EGRESS_CLASSES, modelProviders: MODEL_GATEWAY_PROVIDERS },
  phi: { egress: ["platform", "configured"], modelProviders: ["bedrock"] },
} as const satisfies Record<
  DataBoundaryProfile | "open",
  {
    readonly egress: readonly ToolEgress[];
    readonly modelProviders: readonly ModelGatewayProvider[];
  }
>;

function boundary(profile: DataBoundaryProfile | "open"): DataBoundary {
  const entry = DATA_BOUNDARY_PROFILES[profile];
  return {
    egress: new Set<ToolEgress>(entry.egress),
    modelProviders: new Set<ModelGatewayProvider>(entry.modelProviders),
    profile,
  };
}

const BOUNDARIES = {
  open: boundary("open"),
  phi: boundary("phi"),
} as const satisfies Record<DataBoundaryProfile | "open", DataBoundary>;

/** No stored boundary is the open profile, which admits every egress class and provider. */
export function dataBoundaryOf(stored: OrganizationDataBoundary | undefined): DataBoundary {
  return BOUNDARIES[stored?.profile ?? "open"];
}

export function boundaryAdmitsEgress(boundary: DataBoundary, egress: ToolEgress): boolean {
  return boundary.egress.has(egress);
}

/**
 * A boundary that admits every provider admits every id, so model admission keeps owning the
 * invalid-id error. Under a narrower boundary an id that does not normalize is not admitted.
 */
export function boundaryAdmitsModel(boundary: DataBoundary, modelId: string): boolean {
  if (MODEL_GATEWAY_PROVIDERS.every((provider) => boundary.modelProviders.has(provider))) {
    return true;
  }
  // normalizeModelId maps a blank id to the install default model, which a caller never named.
  if (!modelId.trim()) return false;
  let normalized: string;
  try {
    normalized = normalizeModelId(modelId);
  } catch {
    return false;
  }
  return boundary.modelProviders.has(modelProviderForId(normalized));
}

/** True when every profile admits this egress, so callers can skip the read. */
export function egressAdmittedByEveryProfile(egress: ToolEgress): boolean {
  return Object.values(BOUNDARIES).every((boundary) => boundaryAdmitsEgress(boundary, egress));
}

export interface OrganizationDataBoundaryReader {
  /** A strongly consistent read with no cache; a read error propagates, so callers fail closed. */
  readonly read: (organizationId: Ulid) => Promise<DataBoundary>;
}

export function makeOrganizationDataBoundaryReader(
  database: DynamoDatabaseService,
): OrganizationDataBoundaryReader {
  return {
    read: async (organizationId) =>
      dataBoundaryOf((await loadStanding(database, organizationId, true))?.data.dataBoundary),
  };
}
