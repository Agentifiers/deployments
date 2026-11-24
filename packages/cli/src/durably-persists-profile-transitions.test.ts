import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("profile transitions fsync file contents and the parent-directory rename", async () => {
  const source = await readFile(new URL("./config.ts", import.meta.url), "utf8");
  const fileSync = source.indexOf(
    "await handle.sync()",
    source.indexOf("async function writeConfig"),
  );
  const rename = source.indexOf("await rename(temporaryPath, path)", fileSync);
  const directorySync = source.indexOf("await directoryHandle.sync()", rename);

  expect(fileSync).toBeGreaterThan(-1);
  expect(rename).toBeGreaterThan(fileSync);
  expect(directorySync).toBeGreaterThan(rename);
});
