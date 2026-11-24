import {
  responseCostUsdMicros,
  responseUsageRecord,
  type ModelGatewayServiceTokenClaims,
} from "@deployments-ai/model-gateway";

const USAGE_METRIC_NAMESPACE = "DeploymentsAi/ModelGateway";
/** JSON responses larger than this are passed through without reading their usage. */
const MAX_JSON_USAGE_BYTES = 32 * 1024 * 1024;
/** An SSE line longer than this cannot be a usage chunk worth parsing; it is skipped. */
const MAX_SSE_LINE_BYTES = 1024 * 1024;

export type StreamOutcome = "cancelled" | "completed" | "failed";

export interface ObservedUsage {
  readonly costUsdMicros?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ResponseObserver {
  readonly chunk: (bytes: Uint8Array) => void;
  readonly end: (outcome: StreamOutcome) => void;
}

function tokenCount(...values: unknown[]) {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
}

/**
 * A Responses API stream carries usage on its `response.completed` event as `response.usage`;
 * every other body (chat, embeddings, Responses JSON) carries it as top-level `usage`.
 */
function usageBody(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("type" in payload)) return payload;
  return payload.type === "response.completed" && "response" in payload
    ? payload.response
    : payload;
}

function usageFromResponse(payload: unknown): ObservedUsage | undefined {
  const response = usageBody(payload);
  const usage = responseUsageRecord(response);
  if (!usage) return undefined;
  const inputTokens = tokenCount(usage.prompt_tokens, usage.input_tokens);
  const outputTokens = tokenCount(usage.completion_tokens, usage.output_tokens);
  const costUsdMicros = responseCostUsdMicros(response);
  return {
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads `usage` from the last SSE `data:` chunk that carries one. */
function sseUsageReader() {
  const decoder = new TextDecoder();
  let pendingLine = "";
  let skippingLine = false;
  let usage: ObservedUsage | undefined;
  const line = (text: string) => {
    if (!text.startsWith("data:")) return;
    const payload = text.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    usage = usageFromResponse(parseJson(payload)) ?? usage;
  };
  const feed = (text: string) => {
    const lines = (pendingLine + text).split("\n");
    pendingLine = lines.pop() ?? "";
    for (const complete of lines) {
      if (skippingLine) skippingLine = false;
      else line(complete.replace(/\r$/u, ""));
    }
    if (pendingLine.length > MAX_SSE_LINE_BYTES) {
      pendingLine = "";
      skippingLine = true;
    }
  };
  return {
    chunk: (bytes: Uint8Array) => feed(decoder.decode(bytes, { stream: true })),
    usage: () => {
      feed(decoder.decode());
      if (!skippingLine) line(pendingLine.replace(/\r$/u, ""));
      return usage;
    },
  };
}

/** Reads `usage` from a JSON body, keeping at most {@link MAX_JSON_USAGE_BYTES}. */
function jsonUsageReader() {
  let chunks: Uint8Array[] = [];
  let size = 0;
  return {
    chunk: (bytes: Uint8Array) => {
      if (size > MAX_JSON_USAGE_BYTES) return;
      size += bytes.byteLength;
      if (size > MAX_JSON_USAGE_BYTES) chunks = [];
      else chunks.push(bytes.slice());
    },
    usage: () =>
      size > MAX_JSON_USAGE_BYTES
        ? undefined
        : usageFromResponse(parseJson(Buffer.concat(chunks).toString("utf8"))),
  };
}

export function usageReader(contentType: string | null) {
  return contentType?.toLowerCase().startsWith("text/event-stream")
    ? sseUsageReader()
    : jsonUsageReader();
}

/**
 * Passes a response body through unchanged and on demand (backpressure and incremental delivery
 * are preserved) while showing every chunk to an observer, which hears exactly one `end`.
 */
export function observeResponseBody(
  body: ReadableStream<Uint8Array>,
  observer: ResponseObserver,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const end = (outcome: StreamOutcome) => {
    if (ended) return;
    ended = true;
    observer.end(outcome);
  };
  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        end("cancelled");
        await reader.cancel(reason);
      },
      async pull(controller) {
        let chunk: Uint8Array | undefined;
        try {
          ({ value: chunk } = await reader.read());
        } catch (cause) {
          end("failed");
          controller.error(cause);
          return;
        }
        if (chunk === undefined) {
          controller.close();
          end("completed");
          return;
        }
        observer.chunk(chunk);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

export interface ServiceUsageRecordInput {
  readonly claims: ModelGatewayServiceTokenClaims;
  readonly durationMs: number;
  readonly endpoint: string;
  readonly model: string;
  readonly outcome: StreamOutcome;
  readonly status: number;
  readonly timestamp: number;
  readonly usage: ObservedUsage | undefined;
}

/** One CloudWatch Embedded Metric Format log entry for a service-token model request. */
export function serviceUsageRecord(input: ServiceUsageRecordInput): Record<string, unknown> {
  const { claims, usage } = input;
  const metrics = [
    { Name: "Requests", Unit: "Count" },
    ...(usage?.inputTokens !== undefined ? [{ Name: "InputTokens", Unit: "Count" }] : []),
    ...(usage?.outputTokens !== undefined ? [{ Name: "OutputTokens", Unit: "Count" }] : []),
  ];
  return {
    _aws: {
      CloudWatchMetrics: [
        { Dimensions: [["Service"]], Metrics: metrics, Namespace: USAGE_METRIC_NAMESPACE },
      ],
      Timestamp: input.timestamp,
    },
    Requests: 1,
    Service: claims.service,
    ...(usage?.inputTokens !== undefined ? { InputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { OutputTokens: usage.outputTokens } : {}),
    ...(usage?.costUsdMicros !== undefined ? { costUsdMicros: usage.costUsdMicros } : {}),
    ...(claims.agentDefinitionId ? { agentDefinitionId: claims.agentDefinitionId } : {}),
    durationMs: input.durationMs,
    endpoint: input.endpoint,
    ...(claims.environmentId ? { environmentId: claims.environmentId } : {}),
    event: "model_gateway.usage",
    model: input.model,
    ...(claims.organizationId ? { organizationId: claims.organizationId } : {}),
    outcome: input.outcome,
    ...(claims.projectId ? { projectId: claims.projectId } : {}),
    ...(claims.runId ? { runId: claims.runId } : {}),
    service: claims.service,
    status: input.status,
    ...(claims.workspaceId ? { workspaceId: claims.workspaceId } : {}),
  };
}
