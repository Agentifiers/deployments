import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";
import type { ExtensionTool } from "../extensions/extension-draft.ts";
import {
  extensionPage,
  type ExtensionLocator,
  type ExtensionPage,
  type ExtensionSearch,
  type McpServerOption,
} from "../extensions/extension-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import {
  extensionSummary,
  loadExtensionDirectory,
  type ExtensionDirectory,
  type ExtensionSummary,
} from "./tool-directory.ts";

const EXTENSION_PAGE_SIZE = 25;

export async function loadExtensionPage(
  accessToken: string,
  scope: EnvironmentScope,
  search: ExtensionSearch,
  offset: number,
): Promise<ExtensionPage> {
  return extensionPage(await loadExtensionDirectory(accessToken, scope), {
    offset,
    pageSize: EXTENSION_PAGE_SIZE,
    search,
  });
}

/**
 * `tool` holds the schemas and is present only while the extension is active. `missing` is an ID
 * absent from a complete directory that no name resolved. `unlisted` is an ID beyond the capped
 * directory that no name resolved, so it may exist; `cappedAt` is how many extensions it read.
 */
export type ExtensionDetail =
  | { readonly kind: "found"; readonly summary: ExtensionSummary; readonly tool?: ExtensionTool }
  | { readonly kind: "missing" }
  | { readonly kind: "unlisted"; readonly cappedAt: number };

/**
 * Extensions are read by name, and only an active one answers. The directory resolves the ID, so
 * an archived extension still opens, and a newer extension that reuses the name is not shown. The
 * directory's index lags a create, so an ID it lacks still resolves through the locator's name.
 */
export async function extensionDetail(
  { complete, extensions }: ExtensionDirectory,
  { extensionId, name }: ExtensionLocator,
  readTool: (name: string) => Promise<ExtensionTool | undefined>,
): Promise<ExtensionDetail> {
  const summary = extensions.find((extension) => extension.id === extensionId);
  if (summary === undefined) {
    const tool = name === undefined ? undefined : await readTool(name);
    if (tool?.id === extensionId) return { kind: "found", summary: extensionSummary(tool), tool };
    return complete ? { kind: "missing" } : { cappedAt: extensions.length, kind: "unlisted" };
  }
  if (summary.status !== "active") return { kind: "found", summary };
  const tool = await readTool(summary.name);
  return tool?.id === summary.id ? { kind: "found", summary, tool } : { kind: "found", summary };
}

export async function loadExtensionDetail(
  accessToken: string,
  scope: EnvironmentScope,
  locator: ExtensionLocator,
): Promise<ExtensionDetail> {
  return extensionDetail(
    await loadExtensionDirectory(accessToken, scope),
    locator,
    async (toolName) => {
      try {
        return await callRoute("getExtensionTool", { path: { toolName }, scope }, accessToken);
      } catch (error) {
        if (error instanceof PlatformApiError && error.problem.status === 404) return undefined;
        throw error;
      }
    },
  );
}

export function loadHostedCodeArtifact(
  accessToken: string,
  scope: EnvironmentScope,
  contentHash: string,
) {
  return callRoute("getHostedCodeArtifact", { path: { contentHash }, scope }, accessToken);
}

/** One server read past the capped directory; `null` unless it exists and is active. */
export async function loadMcpServerOption(
  accessToken: string,
  scope: EnvironmentScope,
  id: string,
): Promise<McpServerOption | null> {
  try {
    const { name, status, toolAllowlist } = await callRoute(
      "getMcpServer",
      { path: { id }, scope },
      accessToken,
    );
    return status === "active" ? { id, name, toolAllowlist } : null;
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return null;
    throw error;
  }
}
