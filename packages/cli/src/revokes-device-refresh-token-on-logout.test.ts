import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { configPath, replaceProfile, updateProfile } from "./config.ts";
import type { CliIo } from "./types.ts";

const temporaryDirectories: string[] = [];
const temporaryServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-logout-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  return {
    env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" },
    io,
    stderr,
    stdout,
  };
}

async function liveProfile(test: Awaited<ReturnType<typeof harness>>, apiUrl: string) {
  await updateProfile(
    "default",
    {
      apiKey: "active.payload.signature",
      apiKeyExpiresAt: "2099-01-01T00:00:00.000Z",
      apiUrl,
      mock: false,
      refreshToken: "refresh-token",
    },
    test.env,
  );
}

describe("CLI device logout", () => {
  test("removes local credentials before revoking the refresh token", async () => {
    const test = await harness();
    let requestBody: unknown;
    let localCredentialsPresentDuringRevocation = true;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
        localCredentialsPresentDuringRevocation = Boolean(profile.apiKey || profile.refreshToken);
        requestBody = await request.json();
        return Response.json({ revoked: true });
      },
    });
    temporaryServers.push(server);
    await liveProfile(test, server.url.toString());

    expect(await runCli(["auth", "logout", "--json"], test)).toBe(0);

    expect(requestBody).toEqual({ refreshToken: "refresh-token" });
    expect(localCredentialsPresentDuringRevocation).toBeFalse();
    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect(profile).not.toHaveProperty("apiKey");
    expect(profile).not.toHaveProperty("apiKeyExpiresAt");
    expect(profile).not.toHaveProperty("refreshToken");
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({ status: "logged_out" });
  });

  test("keeps local credentials cleared when server-side revocation fails", async () => {
    const test = await harness();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(
          {
            code: "device_authorization_unavailable",
            detail: "Identity is unavailable.",
            status: 503,
            title: "Identity is unavailable.",
            type: "about:blank",
          },
          { status: 503 },
        );
      },
    });
    temporaryServers.push(server);
    await liveProfile(test, server.url.toString());
    expect(await runCli(["auth", "logout", "--json"], test)).toBe(8);

    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect(profile).not.toHaveProperty("apiKey");
    expect(profile).not.toHaveProperty("apiKeyExpiresAt");
    expect(profile).not.toHaveProperty("refreshToken");
    expect(test.stderr.join("\n")).toContain("Local credentials were removed");
    expect(test.stdout).toEqual([]);
  });

  test("clears an interrupted refresh fence when no revocable credential remains", async () => {
    const test = await harness();
    await replaceProfile(
      "default",
      {
        apiUrl: "https://api.us.deployments.ai",
        credentialState: "refresh-in-progress",
        mock: false,
        refreshAttemptId: "interrupted-attempt",
        refreshStartedAt: "2026-07-28T00:00:00.000Z",
      },
      test.env,
    );

    expect(await runCli(["auth", "logout", "--json"], test)).toBe(0);

    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect(profile).not.toHaveProperty("credentialState");
    expect(profile).not.toHaveProperty("refreshAttemptId");
    expect(profile).not.toHaveProperty("refreshStartedAt");
  });
});
