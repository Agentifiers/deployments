import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./process.ts";

/**
 * Invokes a Lambda synchronously through the AWS CLI with the caller's AWS credentials and returns
 * its JSON result. A function error rejects with the function's response.
 */
export async function invokeLambda(
  run: CommandRunner,
  functionName: string,
  payload: unknown,
): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "lambda-invoke-"));
  const responsePath = join(directory, "response.json");
  try {
    const metadata = JSON.parse(
      await run([
        "aws",
        "lambda",
        "invoke",
        "--function-name",
        functionName,
        "--cli-binary-format",
        "raw-in-base64-out",
        "--cli-read-timeout",
        "900",
        "--payload",
        JSON.stringify(payload),
        "--output",
        "json",
        responsePath,
      ]),
    ) as { readonly FunctionError?: string };
    const response = await readFile(responsePath, "utf8");
    if (metadata.FunctionError) {
      throw new Error(`${functionName} failed (${metadata.FunctionError}): ${response}`);
    }
    return JSON.parse(response);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
