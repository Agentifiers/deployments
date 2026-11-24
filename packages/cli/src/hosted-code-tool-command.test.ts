import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jsonOrFile,
  repeatedOption,
  resolveSecrets,
  sourceLanguage,
} from "./hosted-code-tool-command.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("deployments tool upload inputs", () => {
  it("keeps every repeated --secret in order and stops at --", () => {
    expect(
      repeatedOption(
        ["file.ts", "--secret", "A", "--name", "t", "--secret=B=env:X", "--", "--secret", "C"],
        "secret",
      ),
    ).toEqual(["A", "B=env:X"]);
  });

  it("reads secrets only from environment variables or files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-code-cli-"));
    directories.push(directory);
    await writeFile(join(directory, "token"), "file-secret\n");
    expect(
      await resolveSecrets(
        ["API_KEY", "OTHER=env:SOURCE", `FILE=file:${join(directory, "token")}`],
        {
          API_KEY: "from-name",
          SOURCE: "from-var",
        },
      ),
    ).toEqual({ API_KEY: "from-name", FILE: "file-secret", OTHER: "from-var" });
    expect(resolveSecrets(["API_KEY=plaintext"], {})).rejects.toThrow("NAME=env:VAR");
    expect(resolveSecrets(["MISSING"], {})).rejects.toThrow("MISSING is not set");
    expect(resolveSecrets(["A=env:X", "A=env:X"], { X: "v" })).rejects.toThrow("more than once");
  });

  it("infers source languages and accepts inline or file JSON schemas", async () => {
    expect(sourceLanguage("tool.mts", undefined)).toBe("typescript");
    expect(sourceLanguage("tool.py", undefined)).toBe("python");
    expect(sourceLanguage("tool.txt", "javascript")).toBe("javascript");
    expect(() => sourceLanguage("tool.txt", undefined)).toThrow("--language");
    expect(() => sourceLanguage("tool.js", "ruby")).toThrow("--language");
    const directory = await mkdtemp(join(tmpdir(), "hosted-code-cli-"));
    directories.push(directory);
    const schemaPath = join(directory, "schema.json");
    await writeFile(schemaPath, '{"type":"object","required":["a"]}');
    expect(await jsonOrFile("input-schema", '{"type":"object"}')).toEqual({ type: "object" });
    expect(await jsonOrFile("input-schema", schemaPath)).toEqual({
      required: ["a"],
      type: "object",
    });
    expect(jsonOrFile("output-schema", join(directory, "missing.json"))).rejects.toThrow(
      "--output-schema",
    );
  });
});
