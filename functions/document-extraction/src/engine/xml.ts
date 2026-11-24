import { SaxesParser } from "saxes";
import { LIMITS } from "../limits.ts";
import type { ExtractionContext } from "./extractor.ts";
import { UnusableFile } from "./unusable.ts";
import { inflateEntry, type ZipArchive, type ZipEntry } from "./zip.ts";

export interface XmlHandlers {
  open(name: string, attributes: Readonly<Record<string, string>>): void;
  text(value: string): void;
  close(name: string): void;
}

export function readXmlEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  handlers: XmlHandlers,
  context: ExtractionContext,
): void {
  const parser = new SaxesParser({ xmlns: false, position: false });
  let depth = 0;
  parser.on("error", () => {
    throw new UnusableFile("unreadable", "an XML part is malformed");
  });
  parser.on("doctype", () => {
    throw new UnusableFile("unreadable", "an XML part declares a DOCTYPE");
  });
  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth > LIMITS.xml.maxDepth) {
      throw new UnusableFile(
        "limits_exceeded",
        `an XML part nests deeper than ${LIMITS.xml.maxDepth} elements`,
      );
    }
    handlers.open(tag.name, tag.attributes);
  });
  parser.on("closetag", (tag) => {
    depth -= 1;
    handlers.close(tag.name);
  });
  parser.on("text", (value) => handlers.text(value));
  parser.on("cdata", (value) => handlers.text(value));
  const decoder = new TextDecoder();
  inflateEntry(archive, entry, {
    maxBytes: LIMITS.zip.maxEntryInflatedBytes,
    budget: context.inflation,
    onChunk: (chunk) => parser.write(decoder.decode(chunk, { stream: true })),
  });
  parser.write(decoder.decode());
  parser.close();
}
