import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";
import { ExitCode } from "./exit-codes.ts";

const ORGANIZATION = MOCK_TENANCY_FIXTURE_IDS.organization;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const SECRET = "dpl_scim_c2VjcmV0LXZhbHVlLWZvci10ZXN0cw";
const settings = {
  createdAt: "2026-10-18T09:00:00.000Z",
  defaultRole: "viewer",
  scimBaseUrl: "https://api.example.test/scim/v2",
  tokens: [],
  updatedAt: "2026-10-18T09:00:00.000Z",
};
const token = {
  createdAt: "2026-10-18T09:05:00.000Z",
  createdBy: "01ARZ3NDEKTSV4RRFFQ69G5FA0",
  id: TOKEN_ID,
  tokenPrefix: SECRET.slice(0, 16),
};

const temporaryServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await removeTemporaryDirectories();
});

async function directoryCli(args: readonly string[]) {
  const requests: {
    body: unknown;
    idempotent: boolean;
    method: string;
    organization: string | null;
    pathname: string;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      const pathname = new URL(request.url).pathname;
      requests.push({
        body: text ? (JSON.parse(text) as unknown) : undefined,
        idempotent: request.headers.has("idempotency-key"),
        method: request.method,
        organization: request.headers.get("x-deployments-organization"),
        pathname,
      });
      return request.method === "POST"
        ? Response.json(
            {
              directory: { ...settings, tokens: [token] },
              token: { ...token, secret: SECRET },
            },
            { status: 201 },
          )
        : Response.json(settings);
    },
  });
  temporaryServers.push(server);
  const { directory, io, stderr, stdout } = await harness();
  const exitCode = await runCli(
    [
      ...args,
      "--live",
      "--api-url",
      server.url.toString(),
      "--org",
      ORGANIZATION,
      "--json",
      "--yes",
    ],
    { env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" }, io },
  );
  return { exitCode, requests, stderr, stdout };
}

describe("directory commands", () => {
  it("sets the default role on the organization's directory", async () => {
    const result = await directoryCli(["directory", "set", "--default-role", "viewer"]);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: { defaultRole: "viewer" },
        idempotent: true,
        method: "PUT",
        organization: ORGANIZATION,
        pathname: "/v1/directory",
      },
    ]);
  });

  it("shows the directory settings", async () => {
    const result = await directoryCli(["directory", "show"]);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
      "GET /v1/directory",
    ]);
    expect(JSON.parse(result.stdout.join(""))).toMatchObject({
      defaultRole: "viewer",
      scimBaseUrl: "https://api.example.test/scim/v2",
    });
  });

  it("prints a new token's secret only when asked to reveal it", async () => {
    const revealed = await directoryCli(["directory", "token", "create", "--reveal"]);
    const hidden = await directoryCli(["directory", "token", "create"]);

    expect(revealed.exitCode).toBe(ExitCode.success);
    expect(revealed.requests).toEqual([
      {
        body: undefined,
        idempotent: true,
        method: "POST",
        organization: ORGANIZATION,
        pathname: "/v1/directory/tokens",
      },
    ]);
    expect(JSON.parse(revealed.stdout.join("")).token.secret).toBe(SECRET);
    expect(JSON.parse(hidden.stdout.join("")).token).toBe("[REDACTED]");
  });

  it("revokes a token by ID", async () => {
    const result = await directoryCli(["directory", "token", "revoke", TOKEN_ID]);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
      `DELETE /v1/directory/tokens/${TOKEN_ID}`,
    ]);
  });
});
