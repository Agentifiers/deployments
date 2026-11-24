import { expect, it } from "@effect/vitest";
import { readdir, readFile } from "node:fs/promises";

const liveSourceRoot = new URL("../live/", import.meta.url);

it("keeps live E2E sources portable to the Vitest Node worker", async () => {
  const sourceFiles = (await readdir(liveSourceRoot))
    .filter((fileName) => fileName.endsWith(".ts"))
    .toSorted();
  const bunRuntimeUsers: string[] = [];

  for (const fileName of sourceFiles) {
    const source = await readFile(new URL(fileName, liveSourceRoot), "utf8");
    if (/\bBun\./u.test(source)) bunRuntimeUsers.push(fileName);
  }

  expect(bunRuntimeUsers).toEqual([]);
});
