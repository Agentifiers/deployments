import {
  redactRuntimeSensitiveText,
  type RuntimeProgressEvent,
} from "@deployments-ai/agent-runtime";
import {
  makeRuntimeLogPersistence,
  type DynamoDatabaseService,
  type RuntimeLogBatchInput,
  type Ulid,
} from "@deployments-ai/db";
import {
  RUNTIME_LOG_CAPTURE_POLICY,
  RUNTIME_LOG_LIMITS,
  metadataOnlyAttributes,
  stableSpanId,
  type CaptureMode,
  type RuntimeLogAttributeValue,
  type RuntimeLogLevel,
  type RuntimeLogSource,
  type SpanId,
  type TraceId,
} from "@deployments-ai/observability";
import type { RunRecordValue } from "./types.ts";

type RuntimeLogLine = RuntimeLogBatchInput["lines"][number];

/** What runtime code reports; the emitter applies capture policy, redaction, and bounds. */
export interface RuntimeLogEntry {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly level: RuntimeLogLevel;
  readonly message: string;
  readonly source: RuntimeLogSource;
  readonly spanId?: SpanId;
  readonly time: string;
  readonly toolCallId?: Ulid;
}

/** Output a process printed, one entry per line, kept only when the capture mode allows content. */
export interface RuntimeProcessOutput {
  readonly level: RuntimeLogLevel;
  readonly source: RuntimeLogSource;
  readonly text: string;
  readonly time: string;
  readonly toolCallId?: Ulid;
}

/** Writes the lines of one claimed run execution. Writes are best effort and never throw. */
export interface RuntimeRunLogger {
  readonly log: (entry: RuntimeLogEntry) => void;
  readonly processOutput: (output: RuntimeProcessOutput) => void;
  /** Stores what is buffered and stops accepting lines. */
  readonly close: () => Promise<void>;
}

/** The loggers of the runs this worker currently executes, keyed by run. */
export interface RuntimeRunLogRegistry {
  readonly logger: (runId: string) => RuntimeRunLogger | undefined;
  readonly register: (runId: string, logger: RuntimeRunLogger) => () => void;
}

const FLUSH_INTERVAL_MS = 1_000;
const ELLIPSIS = "…";

export function makeRuntimeRunLogRegistry(): RuntimeRunLogRegistry {
  const loggers = new Map<string, RuntimeRunLogger>();
  return {
    logger: (runId) => loggers.get(runId),
    register: (runId, logger) => {
      loggers.set(runId, logger);
      return () => {
        if (loggers.get(runId) === logger) loggers.delete(runId);
      };
    },
  };
}

function bounded(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}${ELLIPSIS}`;
}

function shapedText(value: string, captureMode: CaptureMode, maximum: number) {
  const text =
    RUNTIME_LOG_CAPTURE_POLICY[captureMode].text === "redact"
      ? redactRuntimeSensitiveText(value)
      : value;
  return bounded(text, maximum);
}

function scalar(value: unknown): RuntimeLogAttributeValue | undefined {
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => scalar(entry) !== undefined)
  ) {
    return value.join(", ");
  }
  return undefined;
}

/**
 * Keeps scalar attributes (lists of scalars become one string) in name order up to the bound.
 * Under `metadata-only` the observability field filter removes content-bearing names first.
 */
export function runtimeLogAttributes(
  attributes: Readonly<Record<string, unknown>>,
  captureMode: CaptureMode,
): Readonly<Record<string, RuntimeLogAttributeValue>> | undefined {
  const permitted =
    RUNTIME_LOG_CAPTURE_POLICY[captureMode].attributes === "metadata"
      ? metadataOnlyAttributes(attributes)
      : attributes;
  const kept = Object.entries(permitted)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]): [string, RuntimeLogAttributeValue][] => {
      const kept = scalar(value);
      if (kept === undefined) return [];
      return [
        [
          bounded(name, 64),
          typeof kept === "string"
            ? shapedText(kept, captureMode, RUNTIME_LOG_LIMITS.attributeValueCharacters)
            : kept,
        ],
      ];
    })
    .slice(0, RUNTIME_LOG_LIMITS.attributes);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** One stored line: the capture mode decides what text and attributes survive. */
export function runtimeLogLine(
  entry: RuntimeLogEntry,
  captureMode: CaptureMode,
  sequence: number,
): RuntimeLogLine {
  const attributes = entry.attributes && runtimeLogAttributes(entry.attributes, captureMode);
  return {
    ...(attributes ? { attributes } : {}),
    level: entry.level,
    message: shapedText(entry.message, captureMode, RUNTIME_LOG_LIMITS.messageCharacters),
    sequence,
    source: entry.source,
    ...(entry.spanId ? { spanId: entry.spanId } : {}),
    time: entry.time,
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
  } as RuntimeLogLine;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function progressSource(eventType: string): RuntimeLogSource {
  if (eventType.startsWith("model.")) return "model";
  if (eventType.startsWith("tool.")) return "tool";
  if (eventType.startsWith("sandbox.")) return "sandbox";
  return "runtime";
}

/**
 * A runtime progress event as a log line. A tool call's line links to the tool span the
 * observability projection derives for that call; every other line links to the run span.
 */
export function progressLogEntry(progress: RuntimeProgressEvent): RuntimeLogEntry {
  const { toolCallId, ...metadata } = progress.metadata ?? {};
  const toolCall = typeof toolCallId === "string" && ULID.test(toolCallId) ? toolCallId : undefined;
  return {
    attributes: { ...metadata, event: progress.eventType },
    level: progress.level,
    message: progress.message,
    source: progressSource(progress.eventType),
    spanId: toolCall
      ? stableSpanId(progress.traceId as TraceId, `tool:${toolCall}`)
      : progress.spanId,
    time: progress.occurredAt,
    ...(toolCall ? { toolCallId: toolCall as Ulid } : {}),
  };
}

/**
 * The logger for one claimed execution of `run`. Lines are buffered and stored in batches of up
 * to `RUNTIME_LOG_LIMITS.batchLines`, at least every second while lines arrive. An execution
 * keeps `RUNTIME_LOG_LIMITS.runExecutionLines` lines; the last is a warning that marks the cut.
 */
export function createRuntimeRunLogger(input: {
  readonly database: DynamoDatabaseService;
  readonly now: () => Date;
  readonly run: RunRecordValue;
  readonly workerId: string;
}): RuntimeRunLogger {
  const { run } = input;
  const captureMode = run.data.captureMode;
  const persistence = makeRuntimeLogPersistence(input.database);
  let buffered: RuntimeLogLine[] = [];
  let accepted = 0;
  let batch = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (buffered.length === 0) return writes;
    const lines = buffered;
    buffered = [];
    const number = batch;
    batch += 1;
    writes = writes.then(() =>
      persistence
        .appendBatch({
          ...(run.data.agentDeploymentId ? { agentDeploymentId: run.data.agentDeploymentId } : {}),
          attempt: run.data.attempt,
          batch: number,
          captureMode,
          createdAt: input.now().toISOString(),
          environmentId: run.data.environmentId,
          lines,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runId: run.data.id,
          threadId: run.data.threadId,
          traceId: run.data.traceId,
          workerId: input.workerId,
        } as RuntimeLogBatchInput)
        .catch((cause: unknown) => {
          // Operator-only: a lost batch must never fail the run it describes.
          console.warn("Runtime log batch could not be stored.", {
            attempt: run.data.attempt,
            batch: number,
            errorType: cause instanceof Error ? cause.name : "UnknownError",
            runId: run.data.id,
          });
        }),
    );
    return writes;
  };

  const accept = (entry: RuntimeLogEntry) => {
    if (closed || accepted >= RUNTIME_LOG_LIMITS.runExecutionLines) return;
    accepted += 1;
    const line =
      accepted === RUNTIME_LOG_LIMITS.runExecutionLines
        ? runtimeLogLine(
            {
              level: "warn",
              message: `This execution reached ${RUNTIME_LOG_LIMITS.runExecutionLines} log lines; later lines were not kept.`,
              source: "runtime",
              time: entry.time,
            },
            captureMode,
            buffered.length,
          )
        : runtimeLogLine(entry, captureMode, buffered.length);
    buffered.push(line);
    if (buffered.length >= RUNTIME_LOG_LIMITS.batchLines) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
  };

  return {
    close: async () => {
      closed = true;
      await flush();
    },
    log: accept,
    processOutput: (output) => {
      if (!RUNTIME_LOG_CAPTURE_POLICY[captureMode].processOutput) return;
      const lines = output.text.split(/\r?\n/u).filter((line) => line.trim() !== "");
      const kept = lines.slice(0, RUNTIME_LOG_LIMITS.processOutputLines);
      const correlation = output.toolCallId
        ? {
            spanId: stableSpanId(run.data.traceId as TraceId, `tool:${output.toolCallId}`),
            toolCallId: output.toolCallId,
          }
        : {};
      for (const message of kept) {
        accept({
          ...correlation,
          level: output.level,
          message,
          source: output.source,
          time: output.time,
        });
      }
      if (lines.length > kept.length) {
        accept({
          ...correlation,
          level: "warn",
          message: `${lines.length - kept.length} more output lines were not kept.`,
          source: output.source,
          time: output.time,
        });
      }
    },
  };
}
