import { createHash } from "node:crypto";
import { Schema } from "effect";
import { AgentDeploymentConfigV1, AgentManifestV1, type JsonValue } from "./schema.ts";

const strictOptions = { onExcessProperty: "error" } as const;

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalValue(value));
}

export function decodeAgentManifest(input: unknown): AgentManifestV1 {
  return Schema.decodeUnknownSync(AgentManifestV1, strictOptions)(input);
}

export function decodeAgentDeploymentConfig(input: unknown): AgentDeploymentConfigV1 {
  return Schema.decodeUnknownSync(AgentDeploymentConfigV1, strictOptions)(input);
}

export function canonicalAgentManifestJson(input: unknown): string {
  return canonicalJson(decodeAgentManifest(input) as JsonValue);
}

export function canonicalAgentDeploymentConfigJson(input: unknown): string {
  return canonicalJson(decodeAgentDeploymentConfig(input) as JsonValue);
}

export function agentManifestContentHash(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalAgentManifestJson(input)).digest("hex")}`;
}

export function agentDeploymentConfigContentHash(input: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalAgentDeploymentConfigJson(input))
    .digest("hex")}`;
}
