import { createHash, randomUUID } from "node:crypto";
import {
  type CreateSandboxInput,
  DEFAULT_LAMBDA_MICROVM_NETWORK_CONNECTORS,
  type LambdaMicrovmProviderConfig,
} from "../types.ts";

function normalizeLambdaMicrovmEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("Lambda MicroVM endpoint is required");
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:") throw new Error("Lambda MicroVM endpoint must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Lambda MicroVM endpoint must not include credentials, a query, or a fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function normalizeControlPathPrefix(prefix: string | undefined): string {
  const trimmed = prefix?.trim() ?? "/__sandbox";
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/gu, "")}`;
}

export function lambdaControlPath(prefix: string, suffix: string) {
  return `${prefix}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

export function readLambdaRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Lambda MicroVM ${context} response`);
  }
  return value as Record<string, unknown>;
}

export function readLambdaString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Invalid Lambda MicroVM ${context} response`);
  }
  return value;
}

export function lambdaMicrovmImageRef(
  config: Pick<LambdaMicrovmProviderConfig, "imageIdentifier" | "imageVersion">,
) {
  return config.imageVersion
    ? `${config.imageIdentifier}@${config.imageVersion}`
    : config.imageIdentifier;
}

export function lambdaRunHookPayload(
  config: Pick<LambdaMicrovmProviderConfig, "runHookPayload">,
  input: CreateSandboxInput,
) {
  return typeof config.runHookPayload === "function"
    ? config.runHookPayload(input)
    : config.runHookPayload;
}

export function lambdaMicrovmNetworkConnectors(connectors: string[] | undefined) {
  const values = (connectors ?? [])
    .map((connector) => connector.trim())
    .filter(
      (connector) => connector !== "" && !DEFAULT_LAMBDA_MICROVM_NETWORK_CONNECTORS.has(connector),
    );
  return values.length > 0 ? values : undefined;
}

export function lambdaClientToken(input: CreateSandboxInput): string {
  if (input.allocationId) return `lease-${input.allocationId}`;
  const nonce = randomUUID()
    .replace(/[^a-zA-Z0-9]/gu, "")
    .slice(0, 24);
  const hash = createHash("sha256")
    .update(
      `${input.organizationId}:${input.projectId}:${input.environmentId}:${input.executionTargetKind}:${input.executionTargetId}:${nonce}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `sandbox-${nonce}-${hash}`;
}

export function readMicrovmId(value: unknown, context: string) {
  return readLambdaString(readLambdaRecord(value, context).microvmId, `${context}.microvmId`);
}

export function readMicrovmEndpoint(value: unknown, context: string) {
  return normalizeLambdaMicrovmEndpoint(
    readLambdaString(readLambdaRecord(value, context).endpoint, `${context}.endpoint`),
  );
}

export function readMicrovmState(value: unknown, context: string) {
  return readLambdaString(readLambdaRecord(value, context).state, `${context}.state`);
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
