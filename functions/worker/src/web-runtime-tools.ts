import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { key, type DynamoDatabaseService, workerPersistence } from "@deployments-ai/db";
import {
  executeSelfHostedWebTool,
  MAX_FIRECRAWL_PARSE_FILE_BYTES,
  SelfHostedWebToolError,
  type SelfHostedWebToolName,
  type SelfHostedWebToolsConfig,
} from "@deployments-ai/web-tools";
import { SELF_HOSTED_WEB_TOOL_NAMES } from "@deployments-ai/tools";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { jsonToolResult, logicallyExpired } from "./builtin-tool-support.ts";
import { artifactBucketAllowed } from "./artifact-buckets.ts";

export interface RuntimeWebToolOptions {
  readonly artifactBucket: string;
  readonly legacyArtifactBuckets?: readonly string[];
  readonly artifactS3: Pick<S3Client, "send">;
  readonly database: DynamoDatabaseService;
  readonly loadConfig: () => Promise<SelfHostedWebToolsConfig> | SelfHostedWebToolsConfig;
}

const MAX_CLAIM_SAFE_WEB_RESULT_BYTES = 128 * 1024;
const MUTATION_SUMMARY_FIELDS = ["id", "success", "status", "message", "url"] as const;

function jsonArtifactByteSize(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function boundedSummaryValue(value: unknown) {
  if (typeof value === "string") return Array.from(value).slice(0, 4_096).join("");
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

function claimSafeWebResult(value: unknown, mutation: boolean) {
  if (!mutation) return { truncated: false, value } as const;
  const originalByteSize = jsonArtifactByteSize(value);
  if (originalByteSize <= MAX_CLAIM_SAFE_WEB_RESULT_BYTES) {
    return { truncated: false, value } as const;
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  return {
    truncated: true,
    value: {
      ...Object.fromEntries(
        MUTATION_SUMMARY_FIELDS.flatMap((field) => {
          const summary = boundedSummaryValue(record[field]);
          return summary === undefined ? [] : [[field, summary]];
        }),
      ),
      originalByteSize,
      truncated: true,
    },
  } as const;
}

function resultCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  for (const name of ["data", "results", "links", "sources"] as const) {
    if (Array.isArray(record[name])) return record[name].length;
  }
  const grouped = record.data;
  if (grouped && typeof grouped === "object" && !Array.isArray(grouped)) {
    const groups = grouped as Readonly<Record<string, unknown>>;
    const counts = ["web", "images", "news"].flatMap((name) =>
      Array.isArray(groups[name]) ? [groups[name].length] : [],
    );
    if (counts.length > 0) return counts.reduce((total, count) => total + count, 0);
  }
  return undefined;
}

function fileName(toolName: SelfHostedWebToolName, toolCallId: string) {
  return `${toolName.replaceAll(".", "-").replaceAll("_", "-")}-${toolCallId}.json`;
}

async function artifactForParse(
  options: RuntimeWebToolOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  artifactId: string,
  scopeId: string,
) {
  if (scopeId !== request.organizationId) {
    throw new SelfHostedWebToolError("Artifact scope does not match.");
  }
  const record = await workerPersistence.read(
    options.database,
    "execution",
    {
      pk: key("ORG", request.organizationId, "ENV", request.environmentId),
      sk: key("ARTIFACT", artifactId),
    },
    true,
  );
  if (
    record?.itemType !== "artifact" ||
    record.data.projectId !== request.projectId ||
    record.data.environmentId !== request.environmentId ||
    record.data.status !== "available" ||
    logicallyExpired(record.data.retentionExpiresAt) ||
    record.data.visibility !== "organization" ||
    !artifactBucketAllowed(
      record.data.storage.bucket,
      options.artifactBucket,
      options.legacyArtifactBuckets,
    ) ||
    !record.data.storage.versionId ||
    record.data.storage.byteSize < 1 ||
    record.data.storage.byteSize > MAX_FIRECRAWL_PARSE_FILE_BYTES
  ) {
    throw new SelfHostedWebToolError("Parse artifact was not found in the current run scope.");
  }
  const response = await options.artifactS3.send(
    new GetObjectCommand({
      Bucket: record.data.storage.bucket,
      Key: record.data.storage.key,
      VersionId: record.data.storage.versionId,
    }),
  );
  if (!response.Body) throw new Error("Parse artifact content was not found.");
  return {
    artifact: record,
    content: new Uint8Array(await response.Body.transformToByteArray()),
  };
}

/**
 * A read that Firecrawl answered with a failure for this page, or that ran past the client
 * deadline. Retrying the run replays the same request and fails the same way (a bot-protected
 * page fails every attempt), so the model gets the failure and can try another source. Busy
 * Firecrawl (425, 429) and failures to reach it at all still retry the run.
 */
function pageFailure(cause: unknown): cause is SelfHostedWebToolError | DOMException {
  if (cause instanceof DOMException) return cause.name === "TimeoutError";
  if (!(cause instanceof SelfHostedWebToolError) || cause.status === undefined) return false;
  return cause.status >= 400 && cause.status !== 425 && cause.status !== 429;
}

function failedWebToolResult(
  toolName: SelfHostedWebToolName,
  cause: SelfHostedWebToolError | DOMException,
): RuntimeToolExecutionResult {
  const timedOut = cause instanceof DOMException;
  const code = timedOut ? "timeout" : (cause.code ?? `http_${cause.status}`);
  const message = timedOut ? "Firecrawl did not answer before the deadline." : cause.message;
  return {
    output: { error: { code, message } },
    outputSummary: `${toolName} failed: ${message}`,
    status: "completed",
  };
}

export function createRuntimeWebBuiltinExecutors(
  options: RuntimeWebToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  return Object.fromEntries(
    SELF_HOSTED_WEB_TOOL_NAMES.map((toolName) => [
      toolName,
      async (request: Parameters<ExecuteRuntimeBuiltinTool>[0]) => {
        let config: SelfHostedWebToolsConfig;
        try {
          config = { ...(await options.loadConfig()), scopeId: request.organizationId };
        } catch (cause) {
          throw new RuntimeToolPreparationRetryableError(toolName, cause);
        }
        let result: unknown;
        try {
          result = await executeSelfHostedWebTool(toolName, request.input ?? {}, config, {
            loadParseArtifact: ({ artifactId, scopeId }) =>
              artifactForParse(options, request, artifactId, scopeId),
          });
        } catch (cause) {
          if (request.effect === "read" && pageFailure(cause)) {
            return failedWebToolResult(toolName, cause);
          }
          if (cause instanceof SelfHostedWebToolError) {
            if (
              cause.status === 425 ||
              cause.status === 429 ||
              (cause.status === 408 && request.effect === "read")
            ) {
              throw new RuntimeToolPreparationRetryableError(toolName, cause);
            }
            if (cause.status === 408) throw cause;
            if (cause.status === undefined || (cause.status >= 400 && cause.status < 500)) {
              throw new TypeError(cause.message, { cause });
            }
          }
          if (cause instanceof TypeError) {
            if (request.effect === "read") {
              throw new RuntimeToolPreparationRetryableError(toolName, cause);
            }
            throw new Error(`Transport failed after dispatching ${toolName}.`, { cause });
          }
          throw cause;
        }
        const count = resultCount(result);
        const safeResult = claimSafeWebResult(result, request.effect !== "read");
        return jsonToolResult({
          fileName: fileName(toolName, request.decision.toolCallId),
          label: `${toolName} response`,
          metadata: {
            source: "firecrawl.self_hosted",
            ...(safeResult.truncated ? { truncated: true } : {}),
            toolName,
          },
          summary:
            count === undefined
              ? `${toolName} completed${safeResult.truncated ? " with a claim-safe response summary" : ""}.`
              : `${toolName} completed with ${count} result(s)${safeResult.truncated ? "; the response was summarized for durable replay" : ""}.`,
          value: safeResult.value,
        });
      },
    ]),
  );
}
