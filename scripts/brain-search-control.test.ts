import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dropErasedIndex } from "./brain-search-control.ts";

const ORGANIZATION = "01M5DPY44RZS1S6VFWDW0YNTBS";

function lambda(response: unknown) {
  const commands: (readonly string[])[] = [];
  return {
    commands,
    run: async (command: readonly string[]) => {
      commands.push(command);
      await writeFile(command.at(-1)!, JSON.stringify(response));
      return JSON.stringify({ StatusCode: 200 });
    },
  };
}

describe("brain:search:control drop-erased-index", () => {
  test("invokes brain-search-erasure for the organization's v1 index and returns its answer", async () => {
    const dropped = { index: "brain-01m5dpy44rzs1s6vfwdw0yntbs-v1", outcome: "dropped" };
    const aws = lambda(dropped);

    const result = await dropErasedIndex(aws.run, [ORGANIZATION]);

    expect([result, aws.commands.map((command) => command.slice(0, -1))]).toEqual([
      { exitCode: 0, result: dropped },
      [
        [
          "aws",
          "lambda",
          "invoke",
          "--function-name",
          "brain-search-erasure",
          "--cli-binary-format",
          "raw-in-base64-out",
          "--cli-read-timeout",
          "900",
          "--payload",
          `{"action":"drop-erased-organization-search-index","index":"brain-01m5dpy44rzs1s6vfwdw0yntbs-v1","organizationId":"${ORGANIZATION}"}`,
          "--output",
          "json",
        ],
      ],
    ]);
  });

  test("passes a named index through and fails when the function refuses", async () => {
    const refused = { index: "brain-*", outcome: "refused", reason: "not-organization-index" };
    const aws = lambda(refused);

    const result = await dropErasedIndex(aws.run, [
      ORGANIZATION,
      "--index",
      "brain-*",
      "--function-name",
      "staging-brain-search-erasure",
    ]);

    expect([result, aws.commands[0]?.[4], JSON.parse(aws.commands[0]![10]!).index]).toEqual([
      { exitCode: 1, result: refused },
      "staging-brain-search-erasure",
      "brain-*",
    ]);
  });

  test("succeeds when the index is already gone", async () => {
    const absent = { index: "brain-01m5dpy44rzs1s6vfwdw0yntbs-v1", outcome: "already-absent" };

    expect(await dropErasedIndex(lambda(absent).run, [ORGANIZATION])).toEqual({
      exitCode: 0,
      result: absent,
    });
  });

  test("requires exactly one organization ULID", async () => {
    const aws = lambda({});
    const failure = (args: readonly string[]) =>
      dropErasedIndex(aws.run, args).catch((error: Error) => error.message.split("\n")[0]);

    expect([
      await failure([]),
      await failure([ORGANIZATION, "brain-01m5dpy44rzs1s6vfwdw0yntbs-v2"]),
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
