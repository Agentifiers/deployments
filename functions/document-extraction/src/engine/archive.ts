import {
  INPUT_FILE_TYPES,
  INPUT_FILE_UNUSABLE_REASONS,
  type DocumentMediaType,
  type InputFileUnusableReason,
} from "@deployments-ai/agent-manifest/input-files";
import type { ArchiveSkipReason, DocumentFacts } from "@deployments-ai/file-text";
import { MAX_FACT_NAME_LENGTH } from "@deployments-ai/file-text/wire";
import { LIMITS } from "../limits.ts";
import type { ExtractionContext, Extractor } from "./extractor.ts";
import { sniff, type SniffedFile } from "./sniff.ts";
import { TextSink, untilTextBudget } from "./text-sink.ts";
import { EntryTooLarge, UnusableFile } from "./unusable.ts";
import { readEntryBytes, readZipDirectory, type ZipArchive, type ZipEntry } from "./zip.ts";

export type ExtractEntry = (
  sniffed: SniffedFile,
  bytes: Uint8Array,
  context: ExtractionContext,
) => Promise<DocumentFacts>;

const NESTED_ARCHIVE = /\.(?:7z|apk|bz2|gz|jar|rar|tar|tgz|war|xz|zip)$/iu;
const SKIP_LABELS: Readonly<Record<ArchiveSkipReason, string>> = {
  directory_or_link: "link",
  encrypted: "password-protected",
  legacy_office_format: "legacy Office file",
  limits_exceeded: "over the processing limits",
  nested_archive: "nested archive",
  no_text: "no readable text",
  unreadable: "damaged",
  unsupported_type: "unsupported type",
};

function isUnusableReason(reason: ArchiveSkipReason): reason is InputFileUnusableReason {
  return (INPUT_FILE_UNUSABLE_REASONS as readonly string[]).includes(reason);
}
const decoder = new TextDecoder();

interface ExtractedEntry {
  readonly path: string;
  readonly mediaType: DocumentMediaType;
  readonly text: string;
}

export function archiveExtractor(extractEntry: ExtractEntry): Extractor<Uint8Array> {
  return async (bytes, context) => {
    const archive = readZipDirectory(bytes);
    const extracted: ExtractedEntry[] = [];
    const skipped: { path: string; reason: ArchiveSkipReason }[] = [];
    let skippedTotal = 0;
    const skipReasons = new Set<ArchiveSkipReason>();
    let collectedBytes = 0;
    let truncated = false;
    const skip = (path: string, reason: ArchiveSkipReason) => {
      skippedTotal += 1;
      skipReasons.add(reason);
      if (skipped.length < LIMITS.archive.maxListedSkips) skipped.push({ path, reason });
    };

    for (const entry of archive.entries) {
      const path = entry.name;
      const baseName = path.split("/").at(-1) ?? path;
      if (entry.isDirectory || path.startsWith("__MACOSX/") || baseName.startsWith("._")) continue;
      if (entry.isSymlink) skip(path, "directory_or_link");
      else if (entry.encrypted) skip(path, "encrypted");
      else if (NESTED_ARCHIVE.test(baseName)) skip(path, "nested_archive");
      else if (extracted.length >= LIMITS.archive.maxExtractedEntries)
        skip(path, "limits_exceeded");
      else {
        const result = await extractArchiveEntry({
          archive,
          entry,
          baseName,
          context,
          capacity: LIMITS.maxTextBytes - collectedBytes,
          extractEntry,
        });
        if ("reason" in result) skip(path, result.reason);
        else {
          extracted.push({ path, mediaType: result.mediaType, text: result.text });
          collectedBytes += result.byteLength;
          if (result.truncated) {
            truncated = true;
            break;
          }
        }
      }
    }

    if (extracted.length === 0) {
      const [onlyReason] = skipReasons;
      if (skipReasons.size === 1 && onlyReason !== undefined && isUnusableReason(onlyReason)) {
        throw new UnusableFile(
          onlyReason,
          `every entry in the archive was skipped: ${SKIP_LABELS[onlyReason]}`,
        );
      }
      throw new UnusableFile("no_text", "no entry in the archive has readable text");
    }
    await untilTextBudget(() => {
      const considered = extracted.length + skippedTotal;
      context.sink.write(`# Archive: ${extracted.length} of ${considered} entries extracted\n`);
      for (const { path, reason } of skipped) {
        context.sink.write(`Skipped: ${path} (${SKIP_LABELS[reason]})\n`);
      }
      if (skippedTotal > skipped.length) {
        context.sink.write(`Skipped ${skippedTotal - skipped.length} more entries\n`);
      }
      for (const [index, { path, mediaType, text }] of extracted.entries()) {
        context.sink.write(
          `\f=== Entry ${index + 1}/${extracted.length}: ${path} (${INPUT_FILE_TYPES[mediaType].label}) ===\n${text}`,
        );
      }
    });
    if (truncated) context.sink.markTruncated();
    return {
      kind: "archive",
      extracted: extracted.map(({ path, mediaType }) => ({
        path: path.slice(0, MAX_FACT_NAME_LENGTH),
        mediaType,
      })),
      skipped: skipped.map(({ path, reason }) => ({
        path: path.slice(0, MAX_FACT_NAME_LENGTH),
        reason,
      })),
      skippedTotal,
    };
  };
}

async function extractArchiveEntry(input: {
  readonly archive: ZipArchive;
  readonly entry: ZipEntry;
  readonly baseName: string;
  readonly context: ExtractionContext;
  readonly capacity: number;
  readonly extractEntry: ExtractEntry;
}): Promise<
  | { readonly reason: ArchiveSkipReason }
  | {
      readonly mediaType: DocumentMediaType;
      readonly text: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
> {
  try {
    const bytes = readEntryBytes(input.archive, input.entry, {
      maxBytes: LIMITS.archive.maxEntryBytes,
      budget: input.context.inflation,
    });
    const sniffed = sniff(bytes, { fileName: input.baseName });
    if (sniffed.mediaType === "application/zip") return { reason: "nested_archive" };
    const sink = new TextSink(input.capacity);
    await input.extractEntry(sniffed, bytes, { sink, inflation: input.context.inflation });
    const entryText = sink.bytes();
    return {
      mediaType: sniffed.mediaType,
      text: decoder.decode(entryText),
      byteLength: entryText.byteLength,
      truncated: sink.truncated,
    };
  } catch (error) {
    if (error instanceof EntryTooLarge) return { reason: "limits_exceeded" };
    if (error instanceof UnusableFile && error.reason !== "limits_exceeded") {
      return { reason: error.reason };
    }
    throw error;
  }
}
