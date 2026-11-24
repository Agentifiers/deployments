import { RELEASE_ENTRY_EXPORTS } from "@agentifiers/deployments-sdk/release-entry";
import type { CliGroup, CliCommand, CliTree } from "./cli-tree.ts";
import type { DocumentedOperation } from "./operations.ts";
import {
  MANIFEST_PATH,
  cliCommandUrl,
  cliPageUrl,
  normalizeDocsPath,
  type DocsPath,
} from "./urls.ts";

const MANIFEST_SCHEMA_VERSION = 2;

export interface ManifestFlag {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly negatable: boolean;
}

export interface ManifestCommand {
  readonly path: readonly string[];
  readonly command: string;
  readonly aliases: readonly string[];
  readonly leaf: boolean;
  readonly url: string;
  readonly flags: readonly ManifestFlag[];
}

export interface ManifestOperation {
  readonly name: string;
  readonly summary: string;
  readonly method: string;
  readonly path: string;
  readonly tag: string;
  readonly url: string;
  readonly cliCommands: readonly string[];
}

export interface DocsManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly operationCount: number;
  readonly operations: readonly ManifestOperation[];
  readonly cliCommands: readonly ManifestCommand[];
  readonly sdk: {
    readonly functions: readonly string[];
    readonly runtimeExports: readonly string[];
  };
  readonly urls: readonly DocsPath[];
}

type StoredManifest = Omit<DocsManifest, "urls"> & { readonly urls: readonly string[] };

function manifestCommand(node: CliGroup | CliCommand): ManifestCommand {
  return {
    path: node.path,
    command: node.command,
    aliases: node.aliases,
    leaf: node.kind === "command",
    url: node.kind === "command" ? cliCommandUrl(node.path) : cliPageUrl(node.path[0]),
    flags:
      node.kind === "command"
        ? node.arguments
            .filter((argument) => argument.kind !== "positional")
            .map((argument) => ({
              name: argument.name,
              aliases: argument.aliases,
              negatable: argument.kind === "boolean",
            }))
        : [],
  };
}

export function buildManifest(input: {
  readonly tree: CliTree;
  readonly operations: readonly DocumentedOperation[];
  readonly pageUrls: readonly string[];
}): DocsManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    operationCount: input.operations.length,
    operations: input.operations.map((operation) => ({
      name: operation.route.name,
      summary: operation.summary,
      method: operation.route.method,
      path: operation.route.path,
      tag: operation.route.tag,
      url: operation.url,
      cliCommands: [...new Set(operation.cli.map((command) => command.command))],
    })),
    cliCommands: [...input.tree.groups, ...input.tree.commands].map(manifestCommand),
    sdk: {
      functions: input.operations.map((operation) => operation.route.name),
      runtimeExports: RELEASE_ENTRY_EXPORTS.map((entry) => entry.name),
    },
    urls: [...new Set(input.pageUrls.map(normalizeDocsPath))].toSorted(),
  };
}

function isStoredManifest(value: unknown): value is StoredManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    "operations" in value &&
    Array.isArray(value.operations) &&
    "cliCommands" in value &&
    Array.isArray(value.cliCommands) &&
    "urls" in value &&
    Array.isArray(value.urls) &&
    "sdk" in value
  );
}

export async function readManifest(): Promise<DocsManifest> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    throw new Error(`${MANIFEST_PATH} is missing. Run \`bun run --cwd apps/docs generate\` first.`);
  }
  const manifest: unknown = await file.json();
  if (!isStoredManifest(manifest)) {
    throw new Error(`${MANIFEST_PATH} is stale. Run \`bun run --cwd apps/docs generate\` again.`);
  }
  return { ...manifest, urls: manifest.urls.map(normalizeDocsPath) };
}
