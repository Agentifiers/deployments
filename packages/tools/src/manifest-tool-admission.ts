import type { AgentManifestSemanticIssue } from "@deployments-ai/agent-manifest";
import {
  boundaryAdmitsEgress,
  makeOrganizationDataBoundaryReader,
  makeToolAdapterNameLookup,
  TOOL_EGRESS_CLASSES,
  type AdmitManifest,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { findPlatformToolAdapterDefinition } from "./catalog.ts";
import { toolEgress } from "./egress.ts";
import { hasPerCallEgressDecision } from "./egress-destinations.ts";
import { toolAdapterDefinitionFromRecord } from "./tool-records.ts";

/**
 * Admits a manifest's declared tools against the organization's data boundary: each tool's egress
 * must be one the boundary allows. An organization whose boundary admits every egress class is
 * answered from the boundary read alone. A public tool whose calls name their destinations is
 * admitted, since the runtime decides each call against the egress allowlist. Under a restricted
 * boundary, a name that resolves to no platform tool or active environment adapter is refused,
 * because its egress cannot be verified.
 */
export function makeManifestToolBoundaryAdmission({
  database,
}: {
  readonly database: DynamoDatabaseService;
}): AdmitManifest {
  const dataBoundaries = makeOrganizationDataBoundaryReader(database);
  const adapterByName = makeToolAdapterNameLookup(database);
  return async (scope, manifest) => {
    const boundary = await dataBoundaries.read(scope.organizationId as Ulid);
    if (TOOL_EGRESS_CLASSES.every((egress) => boundaryAdmitsEgress(boundary, egress))) return [];
    const tools = manifest.spec.capabilities?.tools ?? [];
    const issues = await Promise.all(
      tools.map(async ({ name }, index): Promise<AgentManifestSemanticIssue[]> => {
        const path = `/spec/capabilities/tools/${index}`;
        const platform = findPlatformToolAdapterDefinition(name);
        const adapter = platform ? undefined : await adapterByName(scope, name);
        const definition =
          platform ?? (adapter ? toolAdapterDefinitionFromRecord(adapter) : undefined);
        if (!definition) {
          return [
            {
              code: "tool_outside_data_boundary",
              message: `Tool ${name} is not registered, so its egress cannot be verified against this organization's ${boundary.profile} data boundary.`,
              path,
            },
          ];
        }
        const egress = toolEgress(definition);
        return boundaryAdmitsEgress(boundary, egress) || hasPerCallEgressDecision(definition)
          ? []
          : [
              {
                code: "tool_outside_data_boundary",
                message: `Tool ${name} can reach ${egress} destinations, which this organization's ${boundary.profile} data boundary does not allow.`,
                path,
              },
            ];
      }),
    );
    return issues.flat();
  };
}
