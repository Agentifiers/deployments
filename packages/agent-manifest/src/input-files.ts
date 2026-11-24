/** Extraction stops (truncated) once a document's text reaches this many UTF-8 bytes. */
export const MAX_DOCUMENT_TEXT_BYTES = 3 * 1024 * 1024;
export const MAX_DOCUMENT_SOURCE_BYTES = 32 * 1024 * 1024;
/** Most text of one document a prompt carries; the rest is paged with `attachment.read`. */
export const MAX_PROMPT_DOCUMENT_TEXT_BYTES = 64 * 1024;
/** Platform-managed tool that pages a submitted document's text; releases cannot declare it. */
export const ATTACHMENT_READ_TOOL = "attachment.read";

/**
 * Version of the extraction output: the wire contract and the text layout. The extraction
 * function refuses a request naming another version. Where an installation turns OCR on, v1 reads
 * scanned PDF pages with Amazon Textract DetectDocumentText, one LINE per line in response order;
 * such a page's header says "(OCR)" and the PDF facts count it in `ocrPages`. Changing the OCR
 * engine or how its lines are assembled needs a new version.
 */
export const DOCUMENT_TEXT_EXTRACTOR = "document-text-v1";
export type DocumentTextExtractor = typeof DOCUMENT_TEXT_EXTRACTOR;

type FileExtension = `.${Lowercase<string>}`;

interface InputFileTypeSpec {
  readonly kind: "audio" | "document" | "image";
  readonly extensions: readonly FileExtension[];
  readonly aliases: readonly string[];
  readonly label: string;
}

export const INPUT_FILE_TYPES = {
  "image/jpeg": { kind: "image", extensions: [".jpg", ".jpeg"], aliases: [], label: "JPEG image" },
  "image/png": { kind: "image", extensions: [".png"], aliases: [], label: "PNG image" },
  "image/webp": { kind: "image", extensions: [".webp"], aliases: [], label: "WebP image" },
  "audio/wav": {
    kind: "audio",
    extensions: [".wav"],
    aliases: ["audio/x-wav"],
    label: "WAV audio",
  },
  "audio/mpeg": { kind: "audio", extensions: [".mp3"], aliases: [], label: "MP3 audio" },
  "application/pdf": { kind: "document", extensions: [".pdf"], aliases: [], label: "PDF" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "document",
    extensions: [".docx"],
    aliases: [],
    label: "Word document",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "document",
    extensions: [".xlsx"],
    aliases: [],
    label: "Excel workbook",
  },
  "text/csv": {
    kind: "document",
    extensions: [".csv"],
    aliases: ["application/csv", "text/comma-separated-values"],
    label: "CSV file",
  },
  "text/markdown": {
    kind: "document",
    extensions: [".md", ".markdown"],
    aliases: ["text/x-markdown"],
    label: "Markdown file",
  },
  "application/json": { kind: "document", extensions: [".json"], aliases: [], label: "JSON file" },
  "text/html": { kind: "document", extensions: [".html", ".htm"], aliases: [], label: "HTML page" },
  "application/zip": {
    kind: "document",
    extensions: [".zip"],
    aliases: ["application/x-zip-compressed"],
    label: "ZIP archive",
  },
  "text/plain": {
    kind: "document",
    extensions: [".txt", ".text", ".log"],
    aliases: [],
    label: "text file",
  },
} as const satisfies Record<string, InputFileTypeSpec>;

export type InputFileMediaType = keyof typeof INPUT_FILE_TYPES;
export type InputFileKind = InputFileTypeSpec["kind"];
type MediaTypeOfKind<K extends InputFileKind> = {
  [T in InputFileMediaType]: (typeof INPUT_FILE_TYPES)[T]["kind"] extends K ? T : never;
}[InputFileMediaType];
export type InputImageMediaType = MediaTypeOfKind<"image">;
export type InputAudioMediaType = MediaTypeOfKind<"audio">;
export type InputMediaType = InputAudioMediaType | InputImageMediaType;
export type DocumentMediaType = MediaTypeOfKind<"document">;

function tableKeys<T extends object>(table: T): (keyof T & string)[] {
  return Object.keys(table).filter((key): key is keyof T & string => Object.hasOwn(table, key));
}

export const INPUT_FILE_MEDIA_TYPES: readonly InputFileMediaType[] = tableKeys(INPUT_FILE_TYPES);
const mediaTypesOfKind = <K extends InputFileKind>(kind: K) =>
  INPUT_FILE_MEDIA_TYPES.filter(
    (type): type is MediaTypeOfKind<K> => INPUT_FILE_TYPES[type].kind === kind,
  );
export const INPUT_IMAGE_MEDIA_TYPES: readonly InputImageMediaType[] = mediaTypesOfKind("image");
export const INPUT_AUDIO_MEDIA_TYPES: readonly InputAudioMediaType[] = mediaTypesOfKind("audio");
export const DOCUMENT_MEDIA_TYPES: readonly DocumentMediaType[] = mediaTypesOfKind("document");

export const INPUT_FILE_PROBLEMS = {
  too_large: {
    status: 413,
    copy: "the file is larger than 10 MiB.",
  },
  unsupported_type: {
    status: 422,
    copy: "this file type isn't supported. Attach a PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown, JSON, HTML, or ZIP file, or a JPEG, PNG, or WebP image.",
  },
  legacy_office_format: {
    status: 422,
    copy: "legacy Office files (.doc, .xls, .ppt) aren't supported. Save it as .docx or .xlsx and attach it again.",
  },
  unreadable: {
    status: 422,
    copy: "the file is damaged, or its contents don't match its type.",
  },
  encrypted: {
    status: 422,
    copy: "the file is password-protected. Remove the password and attach it again.",
  },
  no_text: {
    status: 422,
    copy: "the file has no readable text. If it is a scan, OCR found no text or isn't turned on.",
  },
  limits_exceeded: {
    status: 422,
    copy: "the file exceeds the processing limits (decompressed size, number of entries, time, or memory).",
  },
} as const satisfies Record<string, { readonly status: number; readonly copy: string }>;

export type InputFileProblem = keyof typeof INPUT_FILE_PROBLEMS;
export type InputFileUnusableReason = Exclude<InputFileProblem, "too_large">;
export const INPUT_FILE_UNUSABLE_REASONS: readonly InputFileUnusableReason[] = tableKeys(
  INPUT_FILE_PROBLEMS,
).filter((problem): problem is InputFileUnusableReason => problem !== "too_large");

export type InputFileProblemCode = `input_file_${InputFileProblem}`;
export function inputFileProblemCode(problem: InputFileProblem): InputFileProblemCode {
  return `input_file_${problem}`;
}
export const INPUT_FILE_PROBLEM_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  tableKeys(INPUT_FILE_PROBLEMS).map((problem) => [
    inputFileProblemCode(problem),
    INPUT_FILE_PROBLEMS[problem].status,
  ]),
);

export type InputFileOmissionReason =
  | InputFileProblem
  | "attachments_disabled"
  | "images_unsupported"
  | "over_turn_cap";
export const INPUT_FILE_OMISSION_REASONS: readonly InputFileOmissionReason[] = [
  ...tableKeys(INPUT_FILE_PROBLEMS),
  "attachments_disabled",
  "images_unsupported",
  "over_turn_cap",
];

export interface InputFileHint {
  /** Declared media type, possibly with parameters, possibly a bare extension (Teams). */
  readonly contentType?: string;
  readonly fileName?: string;
}

export type InputFileHintResult =
  | { readonly kind: InputFileKind; readonly mediaType: InputFileMediaType }
  | { readonly kind: "unsupported"; readonly reason: InputFileUnusableReason };

const UNSUPPORTED_EXTENSIONS: Readonly<Record<string, InputFileUnusableReason>> = {
  ".doc": "legacy_office_format",
  ".ppt": "legacy_office_format",
  ".pptx": "unsupported_type",
  ".xls": "legacy_office_format",
};

const TYPE_BY_EXTENSION = new Map<string, InputFileMediaType>(
  INPUT_FILE_MEDIA_TYPES.flatMap((type) =>
    INPUT_FILE_TYPES[type].extensions.map((extension) => [extension, type] as const),
  ),
);
const TYPE_BY_DECLARATION = new Map<string, InputFileMediaType>(
  INPUT_FILE_MEDIA_TYPES.flatMap((type) => [
    [type, type] as const,
    ...INPUT_FILE_TYPES[type].aliases.map((alias) => [alias, type] as const),
  ]),
);

function hintForExtension(extension: string): InputFileHintResult | undefined {
  const unsupported = UNSUPPORTED_EXTENSIONS[extension];
  if (unsupported) return { kind: "unsupported", reason: unsupported };
  const mediaType = TYPE_BY_EXTENSION.get(extension);
  return mediaType && { kind: INPUT_FILE_TYPES[mediaType].kind, mediaType };
}

/**
 * The type a hint points at, or why it is known to be unsupported. The extension wins over a
 * declared type because Windows declares .csv as application/vnd.ms-excel and mail clients
 * declare application/octet-stream. Undefined means "no usable hint", not "unsupported".
 */
export function inputFileHint(hint: InputFileHint): InputFileHintResult | undefined {
  const baseName = hint.fileName?.split(/[/\\]/u).at(-1) ?? "";
  const dot = baseName.lastIndexOf(".");
  const byExtension = dot > 0 ? hintForExtension(baseName.slice(dot).toLowerCase()) : undefined;
  if (byExtension) return byExtension;
  const declared = hint.contentType?.split(";")[0]?.trim().toLowerCase();
  if (!declared) return undefined;
  if (!declared.includes("/")) return hintForExtension(`.${declared.replace(/^\./u, "")}`);
  const mediaType = TYPE_BY_DECLARATION.get(declared);
  return mediaType && { kind: INPUT_FILE_TYPES[mediaType].kind, mediaType };
}

const startsWith = (bytes: Uint8Array, offset: number, signature: readonly number[]) =>
  signature.every((value, index) => bytes[offset + index] === value);
const ascii = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

const INPUT_MEDIA_SIGNATURES = {
  "image/jpeg": (bytes) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  "image/png": (bytes) => startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (bytes) =>
    startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP")),
  "audio/wav": (bytes) =>
    startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WAVE")),
  // FF FE is the UTF-16LE byte-order mark; as an MPEG sync it would be Layer I, which no MP3 uses.
  "audio/mpeg": (bytes) =>
    startsWith(bytes, 0, ascii("ID3")) ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && bytes[1] !== 0xfe),
} as const satisfies Record<InputMediaType, (bytes: Uint8Array) => boolean>;

export const INPUT_MEDIA_TYPES: readonly InputMediaType[] = tableKeys(INPUT_MEDIA_SIGNATURES);
/** Every media signature fits in this many leading bytes (RIFF…WEBP and RIFF…WAVE end at 12). */
export const INPUT_MEDIA_SIGNATURE_BYTES = 12;

export function sniffInputMediaType(bytes: Uint8Array): InputMediaType | undefined {
  return INPUT_MEDIA_TYPES.find((type) => INPUT_MEDIA_SIGNATURES[type](bytes));
}
