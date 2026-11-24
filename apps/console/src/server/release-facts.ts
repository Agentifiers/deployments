import "@tanstack/react-start/server-only";
import { PlatformApiError, type PlatformProblem } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fanOut } from "./fan-out.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export interface ReleaseFacts {
  readonly agentDefinitionId: string;
  readonly id: string;
  readonly models: { readonly fallbacks: readonly string[]; readonly primary: string };
  readonly releaseNumber: number;
  readonly status: "active" | "archived";
  readonly workspaceTools: readonly { readonly name: string; readonly required: boolean }[];
}

export type ReleaseLookup = ReadonlyMap<
  string,
  ReleaseFacts | { readonly problem: PlatformProblem }
>;

export function releaseFacts(release: RouteResponse<"getAgentRelease">): ReleaseFacts {
  const { model, capabilities } = release.manifest.spec;
  return {
    agentDefinitionId: release.agentDefinitionId,
    id: release.id,
    models: { fallbacks: model.fallbackIds ?? [], primary: model.id },
    releaseNumber: release.releaseNumber,
    status: release.status,
    workspaceTools: (capabilities?.tools ?? []).flatMap((tool) =>
      tool.authorization === "workspace" ? [{ name: tool.name, required: tool.required }] : [],
    ),
  };
}

export async function loadReleaseFacts(
  accessToken: string,
  scope: EnvironmentScope,
  releaseIds: readonly string[],
): Promise<ReleaseLookup> {
  const entries = await fanOut(
    [...new Set(releaseIds)],
    async (id): Promise<[string, ReleaseFacts | { readonly problem: PlatformProblem }]> => {
      try {
        const release = await callRoute("getAgentRelease", { path: { id }, scope }, accessToken);
        return [id, releaseFacts(release)];
      } catch (error) {
        if (error instanceof PlatformApiError) return [id, { problem: error.problem }];
        throw error;
      }
    },
  );
  return new Map(entries);
}
