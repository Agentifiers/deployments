import { createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { SpanId, TraceId } from "./identifier-codecs.ts";

export * from "./identifier-codecs.ts";

export function createTraceId(): TraceId {
  return Schema.decodeUnknownSync(TraceId)(randomBytes(16).toString("hex"));
}

export function createSpanId(): SpanId {
  return Schema.decodeUnknownSync(SpanId)(randomBytes(8).toString("hex"));
}

export function stableSpanId(traceId: TraceId, identity: string): SpanId {
  const normalized = identity.trim();
  if (!normalized) throw new TypeError("Span identity is required.");
  const digest = createHash("sha256")
    .update("deployments-ai:observability-span:v1\u0000")
    .update(traceId)
    .update("\u0000")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return Schema.decodeUnknownSync(SpanId)(/^0+$/u.test(digest) ? `1${digest.slice(1)}` : digest);
}
