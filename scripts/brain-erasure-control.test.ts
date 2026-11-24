import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "brain-erasure-control.ts");
const usage = "Usage:\n  resume <organizationId> <brainId> <erasureId>";
const organizationId = "01HZX0000000000000000000AA";

async function resume(...ids: readonly string[]) {
  const child = Bun.spawn([process.execPath, script, "resume", ...ids], {
    env: { ...process.env, AWS_REGION: "us-east-2" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

describe("brain-erasure-control resume", () => {
  test("names the first missing ID in argument order", async () => {
    expect(await resume()).toEqual({
      exitCode: 1,
      stderr: `organization ID is required.\n${usage}\n`,
    });
    expect(await resume(organizationId)).toEqual({
      exitCode: 1,
      stderr: `Brain ID is required.\n${usage}\n`,
    });
  }, 300_000);
});
