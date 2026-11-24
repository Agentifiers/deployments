import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  tenantScopeFields,
} from "../record-schema.ts";

export const MAX_GENERATION_REASONING_BYTES = 64 * 1_024;

const textEncoder = new TextEncoder();

type GenerationReasoningDetail = typeof Metadata.Type & { readonly type: `reasoning.${string}` };

const GenerationReasoningDetail = Metadata.pipe(
  Schema.refine(
    (detail): detail is GenerationReasoningDetail =>
      typeof detail.type === "string" && detail.type.startsWith("reasoning."),
    {
      identifier: "GenerationReasoningDetail",
      message: "Reasoning details require a string type that starts with reasoning.",
    },
  ),
);

export const GenerationReasoningDetails = Schema.NonEmptyArray(GenerationReasoningDetail).pipe(
  Schema.check(
    Schema.makeFilter<readonly GenerationReasoningDetail[]>((details) =>
      textEncoder.encode(JSON.stringify(details)).byteLength <= MAX_GENERATION_REASONING_BYTES
        ? undefined
        : `Generation reasoning must not exceed ${MAX_GENERATION_REASONING_BYTES} bytes of JSON.`,
    ),
  ),
);
export type GenerationReasoningDetails = typeof GenerationReasoningDetails.Type;

export const GenerationReasoningRecord = makeRecordSchema("generation-reasoning", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  modelCallIndex: NonNegativeSafeInteger,
  producerAttemptId: NonEmptyString,
  producerModelId: NonEmptyString,
  reasoningDetails: GenerationReasoningDetails,
  runId: Ulid,
  threadId: Ulid,
});
