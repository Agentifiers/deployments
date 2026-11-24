import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLeaks,
  loadVerticalNameDigests,
  NO_VERTICAL_NAME_DIGESTS,
  VERTICAL_NAME_DIGESTS_FILE_ENV,
  verticalNameDigestEntries,
} from "./leak-guard.ts";

describe("findLeaks", () => {
  it("passes clean prose, unrelated numbers, and the documented example ID", () => {
    expect(
      findLeaks(
        "Create an agent with `deployments agent create`.\nOrder 123456789012 shipped.\nUse 01ARZ3NDEKTSV4RRFFQ69G5FAX as the ID.",
        NO_VERTICAL_NAME_DIGESTS,
      ),
    ).toEqual([]);
  });

  it("flags the pending-content marker", () => {
    expect(findLeaks("Intro\nDOCS_CONTENT_PENDING\n", NO_VERTICAL_NAME_DIGESTS)).toEqual([
      { kind: "content-pending", match: "DOCS_CONTENT_PENDING", line: 2, column: 1 },
    ]);
  });

  it("flags ARNs and account IDs that appear in an AWS context", () => {
    expect(
      findLeaks(
        "Role arn:aws:iam::123456789012:role/deploy\nAWS account 210987654321 owns it.",
        NO_VERTICAL_NAME_DIGESTS,
      ),
    ).toEqual([
      { kind: "aws-arn", match: "arn:aws:iam::123456789012:role/deploy", line: 1, column: 6 },
      { kind: "aws-account-id", match: "123456789012", line: 1, column: 19 },
      { kind: "aws-account-id", match: "210987654321", line: 2, column: 13 },
    ]);
  });

  it("flags ULID-shaped identifiers", () => {
    expect(
      findLeaks("Tenant 01HZY3V6Q8J5W2X9K4M7N1P0RS is seeded.", NO_VERTICAL_NAME_DIGESTS),
    ).toEqual([{ kind: "ulid", match: "01HZY3V6Q8J5W2X9K4M7N1P0RS", line: 1, column: 8 }]);
  });

  it("flags vertical names by digest in any case and with or without separators", () => {
    const portal = verticalNameDigestEntries("Example Portal");
    const zork = verticalNameDigestEntries("zork");
    const digests = {
      names: new Set([...portal.names, ...zork.names]),
      leadWords: new Set([...portal.leadWords, ...zork.leadWords]),
    };
    expect(
      findLeaks(
        "The Example Portal team ships ExamplePortal.\nUse zork-tools; an example of portals stays clean.",
        digests,
      ),
    ).toEqual([
      { kind: "vertical-name", match: "Example Portal", line: 1, column: 5 },
      { kind: "vertical-name", match: "ExamplePortal", line: 1, column: 31 },
      { kind: "vertical-name", match: "zork", line: 2, column: 5 },
    ]);
  });
});

describe("verticalNameDigestEntries", () => {
  it("digests the spaced and run-together name plus its lead word, or one word alone", () => {
    expect(verticalNameDigestEntries("Example Portal")).toEqual({
      names: ["bf50a971eb87162f", "a017ff3405396df7"],
      leadWords: ["50d858e0985ecc7f"],
    });
    expect(verticalNameDigestEntries("zork")).toEqual({
      names: ["8b8bb7adb53fd9e5"],
      leadWords: [],
    });
  });

  it("rejects a name the matcher cannot find", () => {
    expect(() => verticalNameDigestEntries("one two three four")).toThrow(
      "A vertical name needs 1 to 3 words.",
    );
    expect(() => verticalNameDigestEntries("--")).toThrow("A vertical name needs 1 to 3 words.");
  });
});

describe("loadVerticalNameDigests", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function digestFile(contents: string) {
    directory = await mkdtemp(join(tmpdir(), "leak-guard-"));
    const path = join(directory, "digests.json");
    await writeFile(path, contents);
    return path;
  }

  it("checks no names when the operator names no digest file", async () => {
    expect(await loadVerticalNameDigests({})).toBe(NO_VERTICAL_NAME_DIGESTS);
  });

  it("reads the operator's digest file and flags the names it lists", async () => {
    const portal = verticalNameDigestEntries("Example Portal");
    const path = await digestFile(JSON.stringify(portal));
    const digests = await loadVerticalNameDigests({ [VERTICAL_NAME_DIGESTS_FILE_ENV]: path });
    expect(findLeaks("Ships ExamplePortal.", digests)).toEqual([
      { kind: "vertical-name", match: "ExamplePortal", line: 1, column: 7 },
    ]);
  });

  it("rejects a digest file that is not a list of 16-hex digests", async () => {
    const path = await digestFile(JSON.stringify({ names: ["Example Portal"], leadWords: [] }));
    expect(loadVerticalNameDigests({ [VERTICAL_NAME_DIGESTS_FILE_ENV]: path })).rejects.toThrow(
      "`names` must be an array of 16-character lowercase hex digests.",
    );
  });
});
