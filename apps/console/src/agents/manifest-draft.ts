import { AGENT_MANIFEST_API_VERSION, AgentManifestV1 } from "@deployments-ai/agent-manifest/schema";
import {
  agentManifestDepthIssue,
  agentManifestSemanticIssues,
} from "@deployments-ai/agent-manifest/semantics";
import { Schema, SchemaIssue } from "effect";
import { canonicalManifestJson } from "./manifest-diff.ts";

/** A location in a manifest: object keys and array indexes from the root. */
export type JsonPath = readonly (number | string)[];

export type JsonObject = Readonly<Record<string, unknown>>;

export interface ManifestIssue {
  readonly message: string;
  readonly path: JsonPath;
}

/**
 * What the editor's text holds. Both editor views edit the same text; only a `valid` draft can
 * be saved, and it carries the manifest exactly as the API will decode it.
 */
export type DraftCheck =
  | { readonly kind: "syntax"; readonly message: string }
  | { readonly kind: "invalid"; readonly issues: readonly ManifestIssue[]; readonly value: unknown }
  | { readonly kind: "valid"; readonly manifest: AgentManifestV1; readonly value: JsonObject };

/** Mirrors `DEFAULT_AGENT_MODEL_ID`, which model-gateway exports only from its server entry. */
const TEMPLATE_MODEL_ID = "openrouter/qwen/qwen3.7-plus";

/**
 * A new agent's starting draft: the smallest manifest the API accepts once the user writes the
 * instructions, which start empty so no placeholder text ships as the agent's real instructions.
 */
export const MANIFEST_TEMPLATE: AgentManifestV1 = {
  apiVersion: AGENT_MANIFEST_API_VERSION,
  kind: "Agent",
  metadata: { key: "new-agent", name: "New agent", version: "1.0.0" },
  spec: {
    instructions: "",
    model: { id: TEMPLATE_MODEL_ID },
    sandbox: { mode: "none" },
  },
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const decodeManifest = Schema.decodeUnknownSync(AgentManifestV1);

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The editor text for a manifest: canonical, pretty-printed JSON. */
export function draftText(manifest: unknown): string {
  return canonicalManifestJson(manifest);
}

/** `/spec/tools/0/name` (the semantic checks' JSON pointers) as a path. */
function pointerPath(pointer: string): JsonPath {
  return pointer
    .split("/")
    .slice(1)
    .filter((segment) => segment !== "")
    .map((segment) => {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      return /^\d+$/u.test(key) ? Number(key) : key;
    });
}

/**
 * Checks a draft the way the API does: strict decoding against `AgentManifestV1` (unknown keys
 * refused), then the platform's semantic rules, each problem at the path it concerns.
 */
export function checkDraft(text: string): DraftCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "syntax", message: error instanceof Error ? error.message : String(error) };
  }
  const depth = agentManifestDepthIssue(value);
  if (depth) {
    return {
      issues: [{ message: depth.message, path: pointerPath(depth.path) }],
      kind: "invalid",
      value,
    };
  }
  let manifest: AgentManifestV1;
  try {
    manifest = decodeManifest(value, { errors: "all", onExcessProperty: "error" });
  } catch (cause) {
    if (!Schema.isSchemaError(cause)) throw cause;
    const issues = formatIssues(cause.issue).issues.map((issue) => ({
      message: issue.message,
      path: (issue.path ?? []).map((segment) =>
        typeof segment === "object" && segment !== null && "key" in segment
          ? (segment.key as number | string)
          : (segment as number | string),
      ),
    }));
    return { issues, kind: "invalid", value };
  }
  const semantic = agentManifestSemanticIssues(manifest);
  if (semantic.length > 0) {
    return {
      issues: semantic.map((issue) => ({ message: issue.message, path: pointerPath(issue.path) })),
      kind: "invalid",
      value,
    };
  }
  return { kind: "valid", manifest, value: value as JsonObject };
}

/** `spec.skills[1]`; the root reads as `manifest`. */
export function pathLabel(path: JsonPath): string {
  if (path.length === 0) return "manifest";
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/** Issues at `path` or inside it. */
export function issuesUnder(issues: readonly ManifestIssue[], path: JsonPath) {
  return issues.filter(
    (issue) =>
      issue.path.length >= path.length &&
      path.every((segment, index) => issue.path[index] === segment),
  );
}

export function getAt(value: unknown, path: JsonPath): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isJsonObject(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

/** A copy of `value` with `next` at `path`; `undefined` removes an object key. */
export function setAt(value: unknown, path: JsonPath, next: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return next;
  if (typeof head === "number") {
    const list = Array.isArray(value) ? [...value] : [];
    list[head] = setAt(list[head], rest, next);
    return list;
  }
  const record: Record<string, unknown> = isJsonObject(value) ? { ...value } : {};
  const child = setAt(record[head], rest, next);
  if (child === undefined) delete record[head];
  else record[head] = child;
  return record;
}
