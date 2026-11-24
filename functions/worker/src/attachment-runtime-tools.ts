import type { S3Client } from "@aws-sdk/client-s3";
import { ATTACHMENT_READ_TOOL } from "@deployments-ai/agent-manifest";
import {
  escapeAttachedFileTags,
  MAX_TOOL_OUTPUT_CONTEXT_BYTES,
} from "@deployments-ai/agent-runtime";
import {
  artifactOwnerOf,
  loadReadableAttachment,
  RunInputArtifactError,
  type DynamoDatabaseService,
  type ReadableAttachment,
  type Ulid,
} from "@deployments-ai/db";
import {
  ATTACHMENT_READ_DEFAULT_BYTES,
  ATTACHMENT_READ_MAX_BYTES,
  ATTACHMENT_TEXT_NOTICE,
} from "@deployments-ai/tools";
import { Buffer } from "node:buffer";
import { optionalInteger, toolInput, ulid } from "./builtin-tool-support.ts";
import {
  isContinuationByte,
  readInputFileText,
  type InputFileStorage,
  type InputFileTextPage,
} from "./input-file-text.ts";
import { loadThreadRunById } from "./record-readers.ts";
import type { ExecuteRuntimeBuiltinTool, RuntimeToolBindingRequest } from "./runtime-tools.ts";

const READ_OUTPUT_MARGIN_BYTES = 2 * 1024;
const MAX_READ_OUTPUT_BYTES = MAX_TOOL_OUTPUT_CONTEXT_BYTES - READ_OUTPUT_MARGIN_BYTES;

export interface RuntimeAttachmentToolOptions {
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly legacyBuckets?: readonly string[];
  readonly now?: () => Date;
  readonly s3: Pick<S3Client, "send">;
}

type AttachmentReadPage = {
  readonly artifactId: string;
  readonly endByte: number;
  readonly name: string;
  readonly nextStartByte?: number;
  readonly notice: typeof ATTACHMENT_TEXT_NOTICE;
  readonly startByte: number;
  readonly status: "ok";
  readonly text: string;
  readonly textBytes: number;
  readonly untrusted: true;
};

async function readableAttachment(
  options: RuntimeAttachmentToolOptions,
  request: Pick<
    RuntimeToolBindingRequest,
    "environmentId" | "organizationId" | "projectId" | "runId" | "threadId"
  >,
  artifactId: Ulid,
): Promise<ReadableAttachment | undefined> {
  const run = await loadThreadRunById(options.database, request, request.runId);
  if (!run)
    throw new Error(`Run ${request.runId} could not be loaded for ${ATTACHMENT_READ_TOOL}.`);
  const caller = run.data.initiatingCaller;
  if (!caller) return undefined;
  try {
    return await loadReadableAttachment(options.database, {
      artifactId,
      environmentId: run.data.environmentId,
      now: options.now?.() ?? new Date(),
      organizationId: run.data.organizationId,
      owner: artifactOwnerOf(caller),
      projectId: run.data.projectId,
      submitted: run.data.inputArtifacts ?? [],
      threadId: run.data.threadId,
    });
  } catch (cause) {
    if (cause instanceof RunInputArtifactError) return undefined;
    throw cause;
  }
}

function fittedPage(attachment: ReadableAttachment, page: InputFileTextPage): AttachmentReadPage {
  const textBytes = attachment.file.text.byteSize;
  const bytes = new TextEncoder().encode(page.text);
  const prefix = (length: number): AttachmentReadPage => {
    let end = length;
    while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
    const endByte = page.startByte + end;
    return {
      artifactId: attachment.record.data.id,
      endByte,
      name: attachment.record.data.name,
      ...(endByte < textBytes ? { nextStartByte: endByte } : {}),
      notice: ATTACHMENT_TEXT_NOTICE,
      startByte: page.startByte,
      status: "ok",
      text: escapeAttachedFileTags(
        end === bytes.byteLength ? page.text : new TextDecoder().decode(bytes.subarray(0, end)),
      ),
      textBytes,
      untrusted: true,
    };
  };
  const fits = (candidate: AttachmentReadPage) =>
    Buffer.byteLength(JSON.stringify(candidate)) <= MAX_READ_OUTPUT_BYTES;
  const whole = prefix(bytes.byteLength);
  if (fits(whole)) return whole;
  let fitting = 0;
  let overflowing = bytes.byteLength;
  while (overflowing - fitting > 1) {
    const middle = Math.floor((fitting + overflowing) / 2);
    if (fits(prefix(middle))) fitting = middle;
    else overflowing = middle;
  }
  return prefix(fitting);
}

function readSummary(page: AttachmentReadPage): string {
  const range =
    page.endByte > page.startByte
      ? `bytes ${page.startByte}–${page.endByte - 1}`
      : `no bytes at ${page.startByte}`;
  const next =
    page.nextStartByte === undefined ? "end of text" : `next startByte ${page.nextStartByte}`;
  return `Read ${range} of ${page.textBytes} from ${JSON.stringify(page.name)}; ${next}.`;
}

export function createRuntimeAttachmentBuiltinExecutors(
  options: RuntimeAttachmentToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const source: InputFileStorage = {
    bucket: options.bucket,
    client: options.s3,
    ...(options.legacyBuckets ? { legacyBuckets: options.legacyBuckets } : {}),
  };
  const read: ExecuteRuntimeBuiltinTool = async (request) => {
    const input = toolInput(request.input ?? {});
    const artifactId = ulid(input.artifactId, "artifactId");
    const startByte =
      optionalInteger(input, "startByte", { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }) ?? 0;
    const maxBytes =
      optionalInteger(input, "maxBytes", { maximum: ATTACHMENT_READ_MAX_BYTES, minimum: 1 }) ??
      ATTACHMENT_READ_DEFAULT_BYTES;
    const attachment = await readableAttachment(options, request, artifactId);
    if (!attachment) {
      return {
        output: { artifactId, status: "input_artifact_unavailable" },
        outputSummary: `Attachment ${artifactId} is not a readable document in this conversation.`,
        status: "completed",
      };
    }
    const page = fittedPage(
      attachment,
      await readInputFileText(source, { attachment, maxBytes, signal: request.signal, startByte }),
    );
    return { output: page, outputSummary: readSummary(page), status: "completed" };
  };
  return { [ATTACHMENT_READ_TOOL]: read };
}
