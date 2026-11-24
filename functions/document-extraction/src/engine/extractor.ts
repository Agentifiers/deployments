import type { DocumentMediaType } from "@deployments-ai/agent-manifest/input-files";
import type { DocumentFacts } from "@deployments-ai/file-text";
import type { TextSink } from "./text-sink.ts";
import type { InflationBudget } from "./zip.ts";

export const TEXT_DOCUMENT_MEDIA_TYPES = [
  "application/json",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
] as const satisfies readonly DocumentMediaType[];
export type TextDocumentMediaType = (typeof TEXT_DOCUMENT_MEDIA_TYPES)[number];
export type BinaryDocumentMediaType = Exclude<DocumentMediaType, TextDocumentMediaType>;

export interface DecodedText {
  readonly text: string;
  readonly encoding: Extract<DocumentFacts, { kind: "text" }>["encoding"];
}

export interface ExtractionContext {
  readonly sink: TextSink;
  readonly inflation: InflationBudget;
}

export type Extractor<Input> = (input: Input, context: ExtractionContext) => Promise<DocumentFacts>;
