import {
  inputFileHint,
  sniffInputMediaType,
  type InputFileHint,
} from "@deployments-ai/agent-manifest/input-files";
import {
  TEXT_DOCUMENT_MEDIA_TYPES,
  type BinaryDocumentMediaType,
  type DecodedText,
  type TextDocumentMediaType,
} from "./extractor.ts";
import { decodeText } from "./text.ts";
import { UnusableFile } from "./unusable.ts";
import { findEntry, hasZipSignature, readZipDirectory } from "./zip.ts";

export type SniffedFile =
  | { readonly family: "binary"; readonly mediaType: BinaryDocumentMediaType }
  | {
      readonly family: "text";
      readonly mediaType: TextDocumentMediaType;
      readonly decoded: DecodedText;
    };

const ascii = (value: string) => Array.from(value, (character) => character.charCodeAt(0));
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PDF_HEADER = ascii("%PDF-");
/** The stream an encrypted .docx/.xlsx keeps inside its OLE2 container, in UTF-16LE. */
const ENCRYPTED_PACKAGE = ascii("EncryptedPackage").flatMap((code) => [code, 0]);
const BYTE_ORDER_MARKS = [
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe],
  [0xfe, 0xff],
];
const BINARY_SIGNATURES: Readonly<
  Record<string, readonly [offset: number, bytes: readonly number[]]>
> = {
  gzip: [0, [0x1f, 0x8b]],
  "7z": [0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  RAR: [0, ascii("Rar!\u001a\u0007")],
  bzip2: [0, ascii("BZh")],
  xz: [0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  zstd: [0, [0x28, 0xb5, 0x2f, 0xfd]],
  ELF: [0, [0x7f, 0x45, 0x4c, 0x46]],
  "Mach-O 64-bit": [0, [0xcf, 0xfa, 0xed, 0xfe]],
  "Mach-O 32-bit": [0, [0xce, 0xfa, 0xed, 0xfe]],
  "Mach-O universal or Java class": [0, [0xca, 0xfe, 0xba, 0xbe]],
  GIF: [0, ascii("GIF8")],
  "TIFF little-endian": [0, [0x49, 0x49, 0x2a, 0x00]],
  "TIFF big-endian": [0, [0x4d, 0x4d, 0x00, 0x2a]],
  "ISO media (HEIC, MP4, MOV)": [4, ascii("ftyp")],
  RTF: [0, ascii("{\\rtf")],
};

const startsWith = (bytes: Uint8Array, offset: number, signature: readonly number[]) =>
  signature.every((value, index) => bytes[offset + index] === value);

function contains(bytes: Uint8Array, needle: readonly number[]) {
  const [first = 0] = needle;
  for (let index = bytes.indexOf(first); index >= 0; index = bytes.indexOf(first, index + 1)) {
    if (startsWith(bytes, index, needle)) return true;
  }
  return false;
}

function sniffZip(bytes: Uint8Array): SniffedFile {
  const archive = readZipDirectory(bytes);
  const main = findEntry(archive, "word/document.xml") ?? findEntry(archive, "xl/workbook.xml");
  if (main?.encrypted) throw new UnusableFile("encrypted", "the document's parts are encrypted");
  if (main?.name === "word/document.xml") {
    return {
      family: "binary",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  if (main?.name === "xl/workbook.xml") {
    return {
      family: "binary",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }
  if (findEntry(archive, "ppt/presentation.xml")) {
    throw new UnusableFile("unsupported_type", "PowerPoint presentations are not supported");
  }
  return { family: "binary", mediaType: "application/zip" };
}

function isTextDocumentMediaType(value: string): value is TextDocumentMediaType {
  return TEXT_DOCUMENT_MEDIA_TYPES.some((type) => type === value);
}

export function sniff(bytes: Uint8Array, hint: InputFileHint): SniffedFile {
  if (contains(bytes.subarray(0, 1_024), PDF_HEADER)) {
    return { family: "binary", mediaType: "application/pdf" };
  }
  if (hasZipSignature(bytes)) return sniffZip(bytes);
  if (startsWith(bytes, 0, OLE2)) {
    if (contains(bytes, ENCRYPTED_PACKAGE)) {
      throw new UnusableFile("encrypted", "the Office document is password-protected");
    }
    throw new UnusableFile("legacy_office_format", "the file is a legacy Office document");
  }
  if (!BYTE_ORDER_MARKS.some((mark) => startsWith(bytes, 0, mark))) {
    const media = sniffInputMediaType(bytes);
    if (media) throw new UnusableFile("unsupported_type", `the bytes are ${media}, not a document`);
    if (
      Object.values(BINARY_SIGNATURES).some(([offset, signature]) =>
        startsWith(bytes, offset, signature),
      )
    ) {
      throw new UnusableFile("unsupported_type", "the file is a binary format with no text");
    }
  }
  const decoded = decodeText(bytes);
  if (decoded === undefined) {
    throw new UnusableFile("unsupported_type", "the file is binary data with no known format");
  }
  const hinted = inputFileHint(hint);
  const mediaType =
    hinted && "mediaType" in hinted && isTextDocumentMediaType(hinted.mediaType)
      ? hinted.mediaType
      : "text/plain";
  if (mediaType === "application/json" && !parsesAsJson(decoded.text)) {
    return { family: "text", mediaType: "text/plain", decoded };
  }
  return { family: "text", mediaType, decoded };
}

function parsesAsJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
