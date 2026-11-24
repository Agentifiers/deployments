import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { configPath, updateProfile } from "./config.ts";
import type { CliIo } from "./types.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
let directory: string | undefined;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

test("a refresh cannot move credentials after the profile API origin changes", async () => {
  directory = await mkdtemp(join(tmpdir(), "deployments-cli-refresh-origin-"));
  const env = { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" };
  const stderr: string[] = [];
  const io: CliIo = {
    isInteractive: false,
    stderr: (value) => stderr.push(value),
    stdout: () => {},
  };
  let releaseRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const originalServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/device-authorizations/token") {
        markRefreshStarted();
        await refreshReleased;
        return Response.json({
          bearerToken: "refreshed.payload.signature",
          expiresIn: 3600,
          refreshToken: "rotated-refresh-token",
          tokenType: "Bearer",
        });
      }
      return Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" });
    },
  });
  const replacementServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ id: "replacement-account" }),
  });
  servers.push(originalServer, replacementServer);
  await updateProfile(
    "default",
    {
      apiKey: "expired.payload.signature",
      apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
      apiUrl: originalServer.url.toString(),
      mock: false,
      refreshToken: "refresh-token",
    },
    env,
  );

  const request = runCli(["whoami", "--live", "--json"], { env, io });
  await refreshStarted;
  await updateProfile("default", { apiUrl: replacementServer.url.toString() }, env);
  releaseRefresh();

  expect(await request).toBe(3);
  const profile = JSON.parse(await readFile(configPath(env), "utf8")).profiles.default;
  expect(profile.apiUrl).toBe(replacementServer.url.toString());
  expect(profile).not.toHaveProperty("apiKey");
  expect(profile).not.toHaveProperty("refreshToken");
  expect(stderr.join("\n")).toContain("profile changed while refreshing");
});
