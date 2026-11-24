import { Schema } from "effect";

const LOWERCASE_HEX = /^[0-9a-f]+$/u;

function w3cIdentifier(label: string, length: number) {
  return Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((value) =>
        value.length === length && LOWERCASE_HEX.test(value) && !/^0+$/u.test(value)
          ? undefined
          : `${label} must be ${length} lowercase hexadecimal characters and cannot be all zeroes.`,
      ),
    ),
  );
}

export const TraceId = w3cIdentifier("traceId", 32);
export type TraceId = typeof TraceId.Type;

export const SpanId = w3cIdentifier("spanId", 16);
export type SpanId = typeof SpanId.Type;

export const TraceContext = Schema.Struct({
  parentSpanId: Schema.optional(SpanId),
  spanId: SpanId,
  traceId: TraceId,
});
export type TraceContext = typeof TraceContext.Type;
