import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dropDisabledIndex, retireErasedIndex } from "./memory-search-control.ts";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G6006";

function lambda(response: unknown, metadata: Readonly<Record<string, unknown>> = {}) {
  const commands: (readonly string[])[] = [];
  return {
    commands,
    run: async (command: readonly string[]) => {
      commands.push(command);
      await writeFile(command.at(-1)!, JSON.stringify(response));
      return JSON.stringify({ StatusCode: 200, ...metadata });
    },
  };
}

describe("memory:search:control drop-disabled-index", () => {
  test("invokes memory-erasure with the drop request and returns its answer", async () => {
    const dropped = { kept: [], outcome: "dropped", receipt: { indexes: ["memory-a-v1"] } };
    const aws = lambda(dropped);

    const result = await dropDisabledIndex(aws.run, [ORGANIZATION]);

    expect([result, aws.commands.map((command) => command.slice(0, -1))]).toEqual([
      { exitCode: 0, result: dropped },
      [
        [
          "aws",
          "lambda",
          "invoke",
          "--function-name",
          "memory-erasure",
          "--cli-binary-format",
          "raw-in-base64-out",
          "--cli-read-timeout",
          "900",
          "--payload",
          `{"action":"drop-disabled-organization-search-index","organizationId":"${ORGANIZATION}"}`,
          "--output",
          "json",
        ],
      ],
    ]);
  });

  test("names another function and fails when the organization is refused", async () => {
    const refused = { outcome: "refused", reason: "no-operator-hold" };
    const aws = lambda(refused);

    const result = await dropDisabledIndex(aws.run, [
      ORGANIZATION,
      "--function-name",
      "staging-memory-erasure",
    ]);

    expect([result, aws.commands[0]?.[4]]).toEqual([
      { exitCode: 1, result: refused },
      "staging-memory-erasure",
    ]);
  });

  test("fails when the function fails", async () => {
    const aws = lambda({ errorMessage: "boom" }, { FunctionError: "Unhandled" });

    expect(
      await dropDisabledIndex(aws.run, [ORGANIZATION]).catch((error: Error) => error.message),
    ).toBe('memory-erasure failed (Unhandled): {"errorMessage":"boom"}');
  });

  test("requires one organization ULID", async () => {
    const aws = lambda({});
    const failure = (args: readonly string[]) =>
      dropDisabledIndex(aws.run, args).catch((error: Error) => error.message);

    expect([await failure([]), await failure(["acme"]), aws.commands]).toEqual([
      "organizationId is required.",
      "Expected a 26-character ULID.",
      [],
    ]);
  });
});

describe("memory:search:control retire-erased-index", () => {
  test("invokes memory-erasure for the organization's v1 index and returns the counts", async () => {
    const retired = {
      index: "memory-01arz3ndektsv4rrffq69g6006-v1",
      indexDrop: "already-absent",
      outcome: "retired",
      retired: { "memory-search-component": 1, "memory-search-generation": 1 },
    };
    const aws = lambda(retired);

    const result = await retireErasedIndex(aws.run, [ORGANIZATION]);

    expect([result, aws.commands.map((command) => command.slice(0, -1))]).toEqual([
      { exitCode: 0, result: retired },
      [
        [
          "aws",
          "lambda",
          "invoke",
          "--function-name",
          "memory-erasure",
          "--cli-binary-format",
          "raw-in-base64-out",
          "--cli-read-timeout",
          "900",
          "--payload",
          `{"action":"retire-erased-organization-search-index","index":"memory-01arz3ndektsv4rrffq69g6006-v1","organizationId":"${ORGANIZATION}"}`,
          "--output",
          "json",
        ],
      ],
    ]);
  });

  test("passes a later index version and fails when the retirement is refused", async () => {
    const refused = { outcome: "refused", reason: "organization-exists" };
    const aws = lambda(refused);

    const result = await retireErasedIndex(aws.run, [
      ORGANIZATION,
      "--index",
      "memory-01arz3ndektsv4rrffq69g6006-v2",
    ]);

    expect([result, JSON.parse(aws.commands[0]?.[10] ?? "{}").index]).toEqual([
      { exitCode: 1, result: refused },
      "memory-01arz3ndektsv4rrffq69g6006-v2",
    ]);
  });

  test("requires exactly one organization ULID", async () => {
    const aws = lambda({});
    const failure = (args: readonly string[]) =>
      retireErasedIndex(aws.run, args).catch((error: Error) => error.message);

    expect([
      await failure([]),
      await failure([ORGANIZATION, ORGANIZATION]),
      await failure(["acme"]),
      aws.commands,
    ]).toEqual([
      "Pass exactly one organizationId.",
      "Pass exactly one organizationId.",
      "Expected a 26-character ULID.",
      [],
    ]);
  });
});
