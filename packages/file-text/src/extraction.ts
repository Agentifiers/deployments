import { createHash } from "node:crypto";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  DOCUMENT_TEXT_EXTRACTOR,
  type DocumentMediaType,
  type InputFileHint,
  type InputFileUnusableReason,
} from "@deployments-ai/agent-manifest/input-files";
import { Exit, Schema } from "effect";
import {
  clampExtractionDeadline,
  type DocumentFacts,
  ExtractionWireRequest,
  ExtractionWireResponse,
} from "./wire.ts";

export interface ExtractionSource {
  /** Version-pinned presigned GET minted by the caller's own role. */
  readonly url: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the exact bytes; the function verifies it before parsing. */
  readonly sha256: string;
}

export interface ExtractionRequest {
  readonly source: ExtractionSource;
  readonly hint: InputFileHint;
  readonly deadlineMs: number;
}

export type ExtractionOutcome =
  | {
      readonly status: "text";
      readonly mediaType: DocumentMediaType;
      /** Normalized UTF-8: `\n` line ends, `\f` between pages, sheets, and archive entries. */
      readonly text: Uint8Array;
      /** Verified against `text` before the outcome is returned. */
      readonly textSha256: string;
      readonly truncated: boolean;
      readonly facts: DocumentFacts;
    }
  /** Deterministic for these bytes and this engine version: store it, never retry it. */
  | {
      readonly status: "unusable";
      readonly reason: InputFileUnusableReason;
      readonly detail?: string;
    };

/** Throttling, deploy skew, transport, or an unclassified function error. Never stored. */
export class ExtractionUnavailableError extends Error {
  override readonly name = "ExtractionUnavailableError";
}

export interface FileTextExtractor {
  extract(request: ExtractionRequest, signal?: AbortSignal): Promise<ExtractionOutcome>;
}

const INVOKE_GRACE_MS = 10_000;

export interface LambdaInvoker {
  send(
    command: InvokeCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<{
    readonly FunctionError?: string | undefined;
    readonly Payload?: Uint8Array | undefined;
  }>;
}

const decodeWireRequest = Schema.decodeUnknownExit(ExtractionWireRequest);
const decodeWireResponse = Schema.decodeUnknownExit(ExtractionWireResponse);
const decodeFunctionError = Schema.decodeUnknownExit(
  Schema.Struct({ errorType: Schema.optionalKey(Schema.String) }),
);

function parsePayload(payload: Uint8Array | undefined): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload ?? new Uint8Array()));
  } catch {
    return undefined;
  }
}

export function makeLambdaFileTextExtractor(options: {
  readonly lambda: LambdaInvoker;
  readonly functionName: string;
}): FileTextExtractor {
  return {
    async extract(request, signal) {
      const deadlineMs = clampExtractionDeadline(request.deadlineMs);
      const wireRequest: ExtractionWireRequest = {
        extractor: DOCUMENT_TEXT_EXTRACTOR,
        source: request.source,
        hint: request.hint,
        deadlineMs,
      };
      if (Exit.isFailure(decodeWireRequest(wireRequest))) {
        return {
          status: "unusable",
          reason: "unreadable",
          detail: "the file's size or names are outside what extraction accepts",
        };
      }
      const timeout = AbortSignal.timeout(deadlineMs + INVOKE_GRACE_MS);
      let result;
      try {
        result = await options.lambda.send(
          new InvokeCommand({
            FunctionName: options.functionName,
            InvocationType: "RequestResponse",
            Payload: new TextEncoder().encode(JSON.stringify(wireRequest)),
          }),
          { abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout },
        );
      } catch (cause) {
        throw new ExtractionUnavailableError("Document extraction could not be invoked.", {
          cause,
        });
      }

      const payload = parsePayload(result.Payload);
      if (result.FunctionError) {
        const functionError = decodeFunctionError(payload);
        if (
          Exit.isSuccess(functionError) &&
          functionError.value.errorType === "Runtime.OutOfMemory"
        ) {
          return { status: "unusable", reason: "limits_exceeded", detail: "function memory" };
        }
        throw new ExtractionUnavailableError(
          `Document extraction failed (${result.FunctionError}).`,
        );
      }

      const decoded = decodeWireResponse(payload);
      if (Exit.isFailure(decoded)) {
        throw new ExtractionUnavailableError("Document extraction returned a malformed response.");
      }
      const response = decoded.value;
      switch (response.status) {
        case "skew":
          throw new ExtractionUnavailableError(
            `Document extraction runs ${response.extractor}, not ${DOCUMENT_TEXT_EXTRACTOR}.`,
          );
        case "unusable":
          return response;
        case "text": {
          const text = new Uint8Array(Buffer.from(response.textBase64, "base64"));
          if (createHash("sha256").update(text).digest("hex") !== response.textSha256) {
            throw new ExtractionUnavailableError("Extracted text does not match its SHA-256.");
          }
          return {
            status: "text",
            mediaType: response.mediaType,
            text,
            textSha256: response.textSha256,
            truncated: response.truncated,
            facts: response.facts,
          };
        }
        default: {
          const unhandled: never = response;
          return unhandled;
        }
      }
    },
  };
}
