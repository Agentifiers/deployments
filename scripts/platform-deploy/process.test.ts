import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const processModule = join(import.meta.dir, "process.ts");

async function runCommandBody(body: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { runMain } from ${JSON.stringify(processModule)}; runMain(${body});`,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("runMain", () => {
  test("exits 0 with the command's output when the command finishes", async () => {
    expect(await runCommandBody(`async () => { process.stdout.write("done\\n"); }`)).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "done\n",
    });
  });

  test("exits 1 with the error message as written when the command rejects", async () => {
    expect(
      await runCommandBody(
        `async () => { throw new Error("id is required.\\nUsage:\\n  resume <id>"); }`,
      ),
    ).toEqual({
      exitCode: 1,
      stderr: "id is required.\nUsage:\n  resume <id>\n",
      stdout: "",
    });
  });

  test("prints every cause in the error's chain after its message", async () => {
    const body = `async () => {
      const denied = new Error("AccessDeniedException: not authorized", { cause: "token expired" });
      throw new Error("Cannot read /relay/key in us-east-2.", { cause: denied });
    }`;
    expect(await runCommandBody(body)).toEqual({
      exitCode: 1,
      stderr:
        "Cannot read /relay/key in us-east-2.\nCaused by: AccessDeniedException: not authorized\nCaused by: token expired\n",
      stdout: "",
    });
  });

  test("names each error in the chain by its name when it is not plain Error", async () => {
    const body = `async () => {
      const notFound = Object.assign(new Error("UnknownError"), { name: "ParameterNotFound" });
      throw Object.assign(new Error("Cannot read /relay/key.", { cause: notFound }), { name: "RelayError" });
    }`;
    expect(await runCommandBody(body)).toEqual({
      exitCode: 1,
      stderr: "RelayError: Cannot read /relay/key.\nCaused by: ParameterNotFound: UnknownError\n",
      stdout: "",
    });
  });

  test("exits 1 when the process runs out of work while the command is still pending", async () => {
    const result = await runCommandBody(`() => Promise.withResolvers<void>().promise`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });
});
