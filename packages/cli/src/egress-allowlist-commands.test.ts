import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";
import { ExitCode } from "./exit-codes.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/v1/organizations/${ORGANIZATION_ID}/egress-allowlist`;
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await removeTemporaryDirectories();
});

async function liveCli(args: readonly string[]) {
  const requests: {
    body: unknown;
    idempotencyKey: string | null;
    method: string;
    organization: string | null;
    path: string;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        body: text ? (JSON.parse(text) as unknown) : undefined,
        idempotencyKey: request.headers.get("idempotency-key"),
        method: request.method,
        organization: request.headers.get("x-deployments-organization"),
        path: new URL(request.url).pathname,
      });
      return Response.json({ entries: [], organizationId: ORGANIZATION_ID, version: 0 });
    },
  });
  servers.push(server);
  const test = await harness();
  const exitCode = await runCli(
    [...args, "--live", "--api-url", server.url.toString(), "--org", ORGANIZATION_ID, "--json"],
    { env: { DEPLOYMENTS_CONFIG_DIR: test.directory, NO_COLOR: "1" }, io: test.io },
  );
  return { exitCode, requests, stderr: test.stderr.join("\n") };
}

describe("egress allowlist commands", () => {
  it("reads the allowlist", async () => {
    const result = await liveCli(["egress-allowlist", "get", ORGANIZATION_ID]);
    expect(result.exitCode, result.stderr).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: undefined,
        idempotencyKey: null,
        method: "GET",
        organization: ORGANIZATION_ID,
        path: PATH,
      },
    ]);
  });

  it("replaces the list from repeated --origin flags with an idempotency key", async () => {
    const result = await liveCli([
      "egress-allowlist",
      "set",
      ORGANIZATION_ID,
      "--origin",
      "https://claims.example.com",
      "--origin",
      "https://labs.example.org",
    ]);
    expect(result.exitCode, result.stderr).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: {
          entries: [
            { origin: "https://claims.example.com" },
            { origin: "https://labs.example.org" },
          ],
        },
        idempotencyKey: expect.any(String),
        method: "PUT",
        organization: ORGANIZATION_ID,
        path: PATH,
      },
    ]);
  });

  it("takes entries with notes as JSON, including an empty list", async () => {
    const withNotes = await liveCli([
      "egress-allowlist",
      "set",
      ORGANIZATION_ID,
      "--entries",
      '[{"origin":"https://claims.example.com","note":"Claims clearinghouse"}]',
    ]);
    const cleared = await liveCli(["egress-allowlist", "set", ORGANIZATION_ID, "--entries", "[]"]);
    expect([withNotes.exitCode, cleared.exitCode]).toEqual([ExitCode.success, ExitCode.success]);
    expect([...withNotes.requests, ...cleared.requests].map(({ body }) => body)).toEqual([
      { entries: [{ note: "Claims clearinghouse", origin: "https://claims.example.com" }] },
      { entries: [] },
    ]);
  });

  it("refuses both or neither of --origin and --entries without sending", async () => {
    const neither = await liveCli(["egress-allowlist", "set", ORGANIZATION_ID]);
    const both = await liveCli([
      "egress-allowlist",
      "set",
      ORGANIZATION_ID,
      "--origin",
      "https://a.example.com",
      "--entries",
      "[]",
    ]);
    expect([neither.exitCode, both.exitCode]).toEqual([ExitCode.usage, ExitCode.usage]);
    expect([...neither.requests, ...both.requests]).toEqual([]);
  });
});
