import type {
  BrainUploadTicketResponse,
  CreateBrainUploadTicketRequest,
} from "@deployments-ai/api-contract/brains";
import { MAX_CONSOLE_REQUEST_BYTES } from "../console-request.ts";

export type BrainMediaType = CreateBrainUploadTicketRequest["mediaType"];

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, BrainMediaType>> = {
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
};

const BRAIN_MEDIA_TYPES: Readonly<Record<BrainMediaType, true>> = {
  "application/json": true,
  "application/pdf": true,
  "text/csv": true,
  "text/html": true,
  "text/markdown": true,
  "text/plain": true,
};

function isBrainMediaType(value: string): value is BrainMediaType {
  return Object.hasOwn(BRAIN_MEDIA_TYPES, value);
}

export const BRAIN_FILE_ACCEPT = [
  ...Object.keys(MEDIA_TYPE_BY_EXTENSION).map((extension) => `.${extension}`),
  ...Object.keys(BRAIN_MEDIA_TYPES),
].join(",");

/** The extension decides, because browsers report a blank or vendor type for many text files. */
export function brainMediaType(fileName: string, browserType: string): BrainMediaType | undefined {
  const dot = fileName.lastIndexOf(".");
  const byExtension =
    dot === -1 ? undefined : MEDIA_TYPE_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()];
  return byExtension ?? (isBrainMediaType(browserType) ? browserType : undefined);
}

const UPLOAD_FIELDS_BYTES = 16_384;

export const CONSOLE_BRAIN_UPLOAD_MAX_BYTES =
  Math.floor((MAX_CONSOLE_REQUEST_BYTES - UPLOAD_FIELDS_BYTES) / 4) * 3;

const FILE_INPUT_MB = 1024 * 1024;

export const CONSOLE_BRAIN_UPLOAD_MAX_LABEL = `${Math.floor((CONSOLE_BRAIN_UPLOAD_MAX_BYTES * 10) / FILE_INPUT_MB) / 10} MB`;

export const MAX_UPLOAD_TITLE_LENGTH = 200;
export const MAX_UPLOAD_IDENTITY_LENGTH = 500;

export type BrainFileProblem = "empty" | "too_large" | "unsupported_type";

export const BRAIN_FILE_PROBLEMS: Readonly<Record<BrainFileProblem, string>> = {
  empty: "The file is empty.",
  too_large: `The console uploads files up to ${CONSOLE_BRAIN_UPLOAD_MAX_LABEL} (${CONSOLE_BRAIN_UPLOAD_MAX_BYTES.toLocaleString("en-US")} bytes). Upload larger files, up to 8 MB, through the API.`,
  unsupported_type: "A Brain takes Markdown, plain text, CSV, JSON, HTML, and PDF files.",
};

export function brainFileProblem(file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}): BrainFileProblem | undefined {
  if (brainMediaType(file.name, file.type) === undefined) return "unsupported_type";
  if (file.size === 0) return "empty";
  return file.size > CONSOLE_BRAIN_UPLOAD_MAX_BYTES ? "too_large" : undefined;
}

export type UploadStep = "put" | "capture" | "restart";

const STEP_WINDOW_MS = 20_000;

export function nextUploadStep(
  ticket: Pick<BrainUploadTicketResponse, "expiresAt" | "status">,
  now: Date,
): UploadStep {
  const inTime = Date.parse(ticket.expiresAt) - now.getTime() > STEP_WINDOW_MS;
  switch (ticket.status) {
    case "consumed":
      return "capture";
    case "issued":
      return inTime ? "put" : "restart";
    case "completed":
      return inTime ? "capture" : "restart";
    case "expired":
    case "rejected":
    case "streaming":
      return "restart";
  }
}
