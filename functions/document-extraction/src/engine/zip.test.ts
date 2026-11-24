import { describe, expect, test } from "bun:test";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import {
  InflationBudget,
  findEntry,
  inflateEntry,
  readEntryBytes,
  readZipDirectory,
} from "./zip.ts";
import { UnusableFile } from "./unusable.ts";
import { zeroFilledZip } from "../test-fixtures/zip-bomb.ts";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();

function inflatedBeforeStop(archiveBytes: Uint8Array, maxBytes: number) {
  const archive = readZipDirectory(archiveBytes);
  let delivered = 0;
  try {
    inflateEntry(archive, archive.entries[0]!, {
      maxBytes,
      budget: new InflationBudget(),
      onChunk: (chunk) => {
        delivered += chunk.byteLength;
      },
    });
  } catch (error) {
    return { delivered, error };
  }
  return { delivered, error: undefined };
}

describe("ZIP reader", () => {
  test("reads entry names and contents from the central directory", () => {
    const archive = readZipDirectory(
      zipSync({
        "reports/": new Uint8Array(),
        "reports/q3.csv": encoder.encode("region,total\nNorth,1200\n"),
        "notes.txt": [encoder.encode("stored"), { level: 0 }],
      }),
    );
    expect(archive.entries.map((entry) => [entry.name, entry.isDirectory, entry.method])).toEqual([
      ["reports/", true, 8],
      ["reports/q3.csv", false, 8],
      ["notes.txt", false, 0],
    ]);
    const read = (name: string) =>
      new TextDecoder().decode(
        readEntryBytes(archive, findEntry(archive, name)!, {
          maxBytes: MiB,
          budget: new InflationBudget(),
        }),
      );
    expect(read("reports/q3.csv")).toBe("region,total\nNorth,1200\n");
    expect(read("notes.txt")).toBe("stored");
  });

  test("refuses bytes without an end of central directory", () => {
    expect(() => readZipDirectory(encoder.encode("PK\u0003\u0004 not really a zip"))).toThrow(
      new UnusableFile("unreadable", "the ZIP end of central directory is missing"),
    );
  });

  test("stops a 200 MiB bomb at the compression-ratio check after a few MiB", () => {
    const { delivered, error } = inflatedBeforeStop(zeroFilledZip(200 * MiB), 128 * MiB);
    expect(error).toEqual(new UnusableFile("limits_exceeded", "an entry inflates more than 200:1"));
    expect(delivered).toBeLessThan(8 * MiB);
  });

  test("caps an entry at its byte limit when the ratio is ordinary", () => {
    const random = new Uint8Array(3 * MiB).map((_, index) => (index * 2_654_435_761) >>> 24);
    const archive = zipSync({ "noise.bin": random }, { level: 1 });
    const { delivered, error } = inflatedBeforeStop(archive, 2 * MiB);
    expect(error).toEqual(
      new UnusableFile("limits_exceeded", "an entry inflates past 2097152 bytes"),
    );
    expect(delivered).toBeLessThanOrEqual(2 * MiB);
  });

  test("charges every entry against one shared inflation budget", () => {
    const text = encoder.encode("x".repeat(64 * 1024));
    const archive = readZipDirectory(zipSync({ "a.txt": text, "b.txt": text }, { level: 0 }));
    const budget = new InflationBudget(100 * 1024);
    readEntryBytes(archive, archive.entries[0]!, { maxBytes: MiB, budget });
    expect(() => readEntryBytes(archive, archive.entries[1]!, { maxBytes: MiB, budget })).toThrow(
      new UnusableFile("limits_exceeded", "the contents inflate past 102400 bytes in total"),
    );
  });

  test("owns the reader because fflate's streaming Unzip keeps inflating after terminate()", () => {
    const bomb = zeroFilledZip(64 * MiB);
    let deliveredAfterTerminate = 0;
    let terminated = false;
    const unzip = new Unzip((file) => {
      file.ondata = (_error, chunk) => {
        if (terminated) {
          deliveredAfterTerminate += chunk.byteLength;
          return;
        }
        terminated = true;
        file.terminate();
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const push = 16 * 1024;
    for (let offset = 0; offset < bomb.byteLength; offset += push) {
      unzip.push(bomb.subarray(offset, offset + push), offset + push >= bomb.byteLength);
    }
    expect(deliveredAfterTerminate).toBeGreaterThan(32 * MiB);

    const { delivered } = inflatedBeforeStop(bomb, 1 * MiB);
    expect(delivered).toBeLessThanOrEqual(1 * MiB);
  });
});
