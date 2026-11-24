import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";
import { ExitCode } from "./exit-codes.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await removeTemporaryDirectories();
});

describe("governance operation history command", () => {
  it("names every operation kind the history route accepts", async () => {
    const test = await harness();

    expect(await runCli(["governance", "operations", "--help", "--no-color"], test)).toBe(0);
    expect(test.stdout.join("\n")).toContain(
      "Operation kind: audit-export, end-user-erasure, tenant-erasure, tenant-export, or thread-erasure",
    );
  });

  it("filters the history by a conversation erasure kind", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}${url.search}`);
        return Response.json({ items: [] });
      },
    });
    servers.push(server);
    const test = await harness();

    const exitCode = await runCli(
      [
        "governance",
        "operations",
        ORGANIZATION_ID,
        "--kind",
        "end-user-erasure",
        "--live",
        "--api-url",
        server.url.toString(),
        "--org",
        ORGANIZATION_ID,
        "--json",
      ],
      { env: { DEPLOYMENTS_CONFIG_DIR: test.directory, NO_COLOR: "1" }, io: test.io },
    );

    expect(exitCode, test.stderr.join("\n")).toBe(ExitCode.success);
    expect(requests).toEqual([
      `GET /v1/organizations/${ORGANIZATION_ID}/governance-operations?kind=end-user-erasure`,
    ]);
  });
});
