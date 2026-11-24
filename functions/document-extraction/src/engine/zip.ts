/**
 * fflate's streaming `Unzip` is not used: it keeps inflating after `terminate()`
 * (see zip.test.ts), so a cap there cannot stop a bomb.
 */
import { Inflate } from "fflate";
import { LIMITS } from "../limits.ts";
import { EntryTooLarge, UnusableFile } from "./unusable.ts";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const UNIX_HOST = 3;
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly encrypted: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  readonly entries: readonly ZipEntry[];
}

export function hasZipSignature(bytes: Uint8Array) {
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

const unreadable = (detail: string) => new UnusableFile("unreadable", detail);
const nameDecoder = new TextDecoder();

function endOfDirectoryOffset(view: DataView) {
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= floor; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_DIRECTORY) return offset;
  }
  throw unreadable("the ZIP end of central directory is missing");
}

export function readZipDirectory(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfDirectoryOffset(view);
  const count = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === ZIP64_MARKER) {
    throw unreadable("ZIP64 archives are not supported");
  }
  if (count > LIMITS.zip.maxCentralDirectoryEntries) {
    throw new UnusableFile(
      "limits_exceeded",
      `the archive lists more than ${LIMITS.zip.maxCentralDirectoryEntries} entries`,
    );
  }
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== DIRECTORY_ENTRY) {
      throw unreadable("the ZIP central directory is corrupt");
    }
    const madeBy = view.getUint16(offset + 4, true) >> 8;
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (compressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw unreadable("ZIP64 archives are not supported");
    }
    if (offset + 46 + nameLength > end) throw unreadable("the ZIP central directory is corrupt");
    const name = nameDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({
      name,
      method: view.getUint16(offset + 10, true),
      encrypted: (flags & 1) === 1,
      isDirectory: name.endsWith("/"),
      isSymlink: madeBy === UNIX_HOST && (mode & FILE_TYPE_MASK) === SYMLINK_MODE,
      compressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, entries };
}

export class InflationBudget {
  #remaining: number;

  constructor(readonly totalBytes: number = LIMITS.zip.maxTotalInflatedBytes) {
    this.#remaining = totalBytes;
  }

  consume(bytes: number) {
    this.#remaining -= bytes;
    if (this.#remaining < 0) {
      throw new UnusableFile(
        "limits_exceeded",
        `the contents inflate past ${this.totalBytes} bytes in total`,
      );
    }
  }
}

function entryData(archive: ZipArchive, entry: ZipEntry) {
  const view = new DataView(
    archive.bytes.buffer,
    archive.bytes.byteOffset,
    archive.bytes.byteLength,
  );
  const local = entry.localHeaderOffset;
  if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_HEADER) {
    throw unreadable("a ZIP local header is corrupt");
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + entry.compressedSize > view.byteLength) {
    throw unreadable("a ZIP entry runs past the end of the archive");
  }
  return archive.bytes.subarray(start, start + entry.compressedSize);
}

export function inflateEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  options: {
    readonly maxBytes: number;
    readonly budget: InflationBudget;
    readonly onChunk: (chunk: Uint8Array) => void;
  },
): void {
  if (entry.encrypted) throw new UnusableFile("encrypted", "a ZIP entry is encrypted");
  const data = entryData(archive, entry);
  let inflated = 0;
  let consumed = 0;
  const accept = (chunk: Uint8Array) => {
    inflated += chunk.byteLength;
    if (inflated > options.maxBytes) throw new EntryTooLarge(options.maxBytes);
    options.budget.consume(chunk.byteLength);
    if (
      inflated > LIMITS.zip.ratioFloorBytes &&
      inflated > LIMITS.zip.maxCompressionRatio * consumed
    ) {
      throw new UnusableFile(
        "limits_exceeded",
        `an entry inflates more than ${LIMITS.zip.maxCompressionRatio}:1`,
      );
    }
    options.onChunk(chunk);
  };
  switch (entry.method) {
    case 0:
      consumed = data.byteLength;
      accept(data);
      return;
    case 8: {
      const inflater = new Inflate(accept);
      const slice = LIMITS.zip.inflateSliceBytes;
      try {
        for (let offset = 0; offset < data.byteLength; offset += slice) {
          consumed = Math.min(data.byteLength, offset + slice);
          inflater.push(data.subarray(offset, consumed), consumed === data.byteLength);
        }
      } catch (error) {
        // fflate reports malformed DEFLATE data as an Error with a numeric code.
        if (error instanceof Error && "code" in error && typeof error.code === "number") {
          throw unreadable("a ZIP entry's compressed data is corrupt");
        }
        throw error;
      }
      return;
    }
    default:
      throw unreadable(`ZIP compression method ${entry.method} is not supported`);
  }
}

export function readEntryBytes(
  archive: ZipArchive,
  entry: ZipEntry,
  options: { readonly maxBytes: number; readonly budget: InflationBudget },
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  inflateEntry(archive, entry, {
    ...options,
    onChunk: (chunk) => {
      chunks.push(chunk);
      length += chunk.byteLength;
    },
  });
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function findEntry(archive: ZipArchive, name: string) {
  return archive.entries.find((entry) => entry.name === name);
}
