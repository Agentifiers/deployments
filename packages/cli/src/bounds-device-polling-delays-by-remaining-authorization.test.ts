import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { configPath, resolveContext, updateProfile } from "./config.ts";
import { devicePollingDelayMilliseconds } from "./profile-commands.ts";
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

async function harness(mock = true) {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  return {
    directory,
    env: {
      DEPLOYMENTS_CONFIG_DIR: directory,
      ...(mock ? { DEPLOYMENTS_MOCK: "1" } : {}),
      NO_COLOR: "1",
    },
    io,
    stdout,
    stderr,
  };
}

describe("CLI execution", () => {
  it("bounds device polling delays by the remaining authorization lifetime", () => {
    expect(devicePollingDelayMilliseconds(10_000, 2_000, 1_000)).toBe(2_000);
    expect(devicePollingDelayMilliseconds(10_000, 20_000, 1_000)).toBe(9_000);
    expect(devicePollingDelayMilliseconds(10_000, 20_000, 10_000)).toBe(0);
  });

  it("emits clean machine-readable output without trailing help", async () => {
    const test = await harness();
    expect(await runCli(["project", "list", "--json", "--no-color"], test)).toBe(0);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toHaveLength(1);
    const payload = JSON.parse(test.stdout[0]!);
    expect(payload.nextCursor).toBeNull();
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({
      organizationId: MOCK_TENANCY_FIXTURE_IDS.organization,
      id: MOCK_TENANCY_FIXTURE_IDS.project,
    });

    const human = await harness();
    expect(await runCli(["project", "list"], human)).toBe(0);
    expect(human.stdout.join("\n")).not.toContain("\u001b");
  });

  it("redacts secrets by default and reveals only on explicit request", async () => {
    const hidden = await harness();
    const command = [
      "api-key",
      "create",
      "--name",
      "ci",
      "--service-account",
      MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
      "--expires",
      "2026-08-01T00:00:00.000Z",
      "--json",
      "--no-color",
    ];
    expect(await runCli(command, hidden)).toBe(0);
    expect(JSON.parse(hidden.stdout[0]!).secret).toBe("[REDACTED]");

    const revealed = await harness();
    expect(await runCli([...command, "--reveal"], revealed)).toBe(0);
    expect(JSON.parse(revealed.stdout[0]!)).toMatchObject({
      expiresAt: "2026-08-01T00:00:00.000Z",
      secret: "dpl_mock_secret_value",
      serviceAccountId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
    });
  });

  it("returns operational list pages in mock mode", async () => {
    for (const command of [
      ["usage", "show"],
      ["cost", "show"],
      ["spend", "show"],
      ["api-key", "usage"],
    ]) {
      const test = await harness();
      expect(await runCli([...command, "--json"], test)).toBe(0);
      const page = JSON.parse(test.stdout[0]!);
      expect(page).toMatchObject({
        items: [{ data: expect.any(Object), type: expect.any(String) }],
      });
      expect(page).not.toHaveProperty("nextCursor");
    }
    const audit = await harness();
    expect(await runCli(["audit", "list", "--json"], audit)).toBe(0);
    expect(JSON.parse(audit.stdout[0]!)).toMatchObject({
      items: [
        {
          action: expect.any(String),
          actor: { type: "principal" },
          id: expect.any(String),
          occurredAt: expect.any(String),
        },
      ],
    });

    const identity = await harness();
    expect(await runCli(["whoami", "--json"], identity)).toBe(0);
    expect(JSON.parse(identity.stdout[0]!)).toMatchObject({
      authentication: "api-credential",
      capabilities: ["platform:*"],
      environmentIds: expect.any(Array),
      organizationIds: expect.any(Array),
      projectIds: expect.any(Array),
    });
  });

  it("persists profile context in a private config file", async () => {
    const test = await harness();
    expect(
      await runCli(
        ["context", "set", "--org", "org_1", "--project", "prj_1", "--env", "env_1", "--json"],
        test,
      ),
    ).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      organizationId: "org_1",
      projectId: "prj_1",
      environmentId: "env_1",
    });
    expect(JSON.parse(await readFile(configPath(test.env), "utf8"))).toMatchObject({
      currentProfile: "default",
    });
    expect((await stat(configPath(test.env))).mode & 0o777).toBe(0o600);

    const before = await readFile(configPath(test.env), "utf8");
    for (const invalidOrg of ["", "   ", " org_padded "]) {
      test.stdout.length = 0;
      test.stderr.length = 0;
      expect(await runCli(["context", "set", "--org", invalidOrg, "--json"], test)).toBe(7);
      expect(await readFile(configPath(test.env), "utf8")).toBe(before);
    }

    test.stdout.length = 0;
    test.stderr.length = 0;
    expect(await runCli(["project", "list", "--env", "", "--json"], test)).toBe(7);
    expect(test.stderr.join("\n")).toContain("--env must be a non-empty");

    test.stdout.length = 0;
    test.stderr.length = 0;
    expect(await runCli(["auth", "logout", "--profile", "", "--json"], test)).toBe(7);

    for (const command of [
      ["auth", "logout", "--profile", "missing", "--json"],
      ["context", "clear", "--profile", "missing", "--json"],
    ]) {
      test.stderr.length = 0;
      expect(await runCli(command, test)).toBe(7);
      expect(test.stderr.join("\n")).toContain("Unknown CLI profile: missing");
      expect(await readFile(configPath(test.env), "utf8")).toBe(before);
    }

    for (const command of [
      ["auth", "login", "--api-key", " ", "--json"],
      ["health", "--api-url", " ", "--json"],
    ]) {
      test.stderr.length = 0;
      expect(await runCli(command, test)).toBe(7);
      expect(test.stderr.join("\n")).toContain("must be a non-empty, unpadded value");
    }

    test.stderr.length = 0;
    expect(
      await runCli(["context", "show", "--json"], {
        ...test,
        env: { ...test.env, DEPLOYMENTS_PROFILE: "default " },
      }),
    ).toBe(7);
    expect(test.stderr.join("\n")).toContain("DEPLOYMENTS_PROFILE must be a non-empty");
  });

  it("serializes concurrent profile mutations", async () => {
    const test = await harness();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        updateProfile(`profile-${index}`, { organizationId: `org_${index}` }, test.env),
      ),
    );

    const config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    for (let index = 0; index < 8; index += 1) {
      expect(config.profiles[`profile-${index}`]?.organizationId).toBe(`org_${index}`);
    }
  });

  it("ignores empty or relative XDG config roots", () => {
    const expected = join(homedir(), ".config", "deployments", "config.json");
    expect(configPath({ XDG_CONFIG_HOME: "" })).toBe(expected);
    expect(configPath({ XDG_CONFIG_HOME: "relative-config" })).toBe(expected);
    for (const invalidRoot of ["", "relative-config", "/tmp/padded "]) {
      expect(() => configPath({ DEPLOYMENTS_CONFIG_DIR: invalidRoot })).toThrow(
        "DEPLOYMENTS_CONFIG_DIR must be a non-empty, unpadded absolute path",
      );
    }
  });

  it("rejects unsupported config versions without overwriting them", async () => {
    const test = await harness();
    expect(await runCli(["context", "set", "--org", "org_1", "--json"], test)).toBe(0);
    const newerConfig = {
      version: 2,
      currentProfile: "future",
      profiles: { future: { apiUrl: "https://future.example.test", mock: false } },
      futureField: { preserve: true },
    };
    await writeFile(configPath(test.env), `${JSON.stringify(newerConfig, null, 2)}\n`);

    test.stdout.length = 0;
    test.stderr.length = 0;
    expect(await runCli(["context", "set", "--org", "org_2", "--json"], test)).toBe(7);
    expect(test.stderr.join("\n")).toContain("Unsupported CLI config version: 2");
    expect(JSON.parse(await readFile(configPath(test.env), "utf8"))).toEqual(newerConfig);
  });

  it("rejects malformed version-1 configs without overwriting them", async () => {
    const malformedConfigs = [
      {
        version: 1,
        profiles: { default: { apiUrl: "https://api.example.test", mock: true } },
      },
      { version: 1, currentProfile: "default", profiles: [] },
      {
        version: 1,
        currentProfile: "default",
        profiles: {
          default: { apiUrl: 42, mock: true },
          valid: { apiUrl: "https://api.example.test", mock: true },
        },
      },
      {
        version: 1,
        currentProfile: "constructor",
        profiles: { default: { apiUrl: "https://api.example.test", mock: true } },
      },
    ];

    for (const malformedConfig of malformedConfigs) {
      const test = await harness();
      expect(await runCli(["context", "set", "--org", "org_1", "--json"], test)).toBe(0);
      await writeFile(configPath(test.env), `${JSON.stringify(malformedConfig, null, 2)}\n`);
      test.stdout.length = 0;
      test.stderr.length = 0;

      expect(await runCli(["context", "set", "--org", "org_2", "--json"], test)).toBe(7);
      expect(test.stderr.join("\n")).toContain("Invalid CLI config");
      expect(JSON.parse(await readFile(configPath(test.env), "utf8"))).toEqual(malformedConfig);
    }
  });

  it("classifies malformed JSON config as validation without overwriting it", async () => {
    const test = await harness();
    expect(await runCli(["context", "set", "--org", "org_1", "--json"], test)).toBe(0);
    const malformedJson = '{"version":1,"profiles":';
    await writeFile(configPath(test.env), malformedJson);
    test.stdout.length = 0;
    test.stderr.length = 0;

    expect(await runCli(["context", "show", "--json"], test)).toBe(7);
    expect(test.stderr.join("\n")).toContain("Invalid CLI config JSON");
    expect(await readFile(configPath(test.env), "utf8")).toBe(malformedJson);
  });

  it("logs in to the active profile by default", async () => {
    const test = await harness();
    expect(
      await runCli(["context", "set", "--profile", "staging", "--org", "org_1", "--json"], test),
    ).toBe(0);
    expect(await runCli(["auth", "login", "--json"], test)).toBe(0);
    const config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    expect(config.currentProfile).toBe("staging");
    expect(config.profiles.staging.apiKey).toBe("dpl_mock_session");
    expect(config.profiles.default.apiKey).toBeUndefined();
  });

  it("replaces a fenced device profile with a valid mock credential", async () => {
    const test = await harness();
    await updateProfile(
      "default",
      {
        credentialState: "reauthentication-required",
        mock: false,
      },
      test.env,
    );

    expect(await runCli(["auth", "login", "--mock", "--json"], test)).toBe(0);
    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect(profile).toMatchObject({ apiKey: "dpl_mock_session", mock: true });
    expect(profile).not.toHaveProperty("credentialState");
    expect(profile).not.toHaveProperty("refreshAttemptId");
    expect(profile).not.toHaveProperty("refreshStartedAt");
  });

  it("completes interactive device authorization when no bearer is supplied", async () => {
    const test = await harness();
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === "/v1/device-authorizations") {
          return Response.json({
            deviceCode: "device-secret",
            expiresIn: 600,
            interval: 1,
            userCode: "ABCD\u001b]52;c;Y2xpcGJvYXJk\u0007-EFGH",
            verificationUri: "https://login.example/device\u001b]52;c;Y2xpcGJvYXJk\u0007",
          });
        }
        if (path === "/v1/device-authorizations/token") {
          return Response.json({
            bearerToken: "header.payload.signature",
            expiresIn: 3600,
            tokenType: "Bearer",
          });
        }
        return Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" });
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiUrl: server.url.toString(),
        credentialState: "refresh-in-progress",
        mock: false,
        refreshAttemptId: "interrupted-attempt",
        refreshStartedAt: "2026-07-28T00:00:00.000Z",
      },
      test.env,
    );

    expect(
      await runCli(["auth", "login", "--live", "--api-url", server.url.toString()], {
        ...test,
        io: { ...test.io, isInteractive: true },
      }),
    ).toBe(0);
    expect(paths).toEqual([
      "/v1/device-authorizations",
      "/v1/device-authorizations/token",
      "/v1/whoami",
    ]);
    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect(profile).toMatchObject({
      apiKey: "header.payload.signature",
      apiKeyExpiresAt: expect.any(String),
    });
    expect(profile).not.toHaveProperty("refreshToken");
    expect(profile).not.toHaveProperty("credentialState");
    expect(profile).not.toHaveProperty("refreshAttemptId");
    expect(profile).not.toHaveProperty("refreshStartedAt");
    expect(test.stderr.join("\n")).toContain(
      "Open https://login.example/device and enter code ABCD-EFGH.",
    );
    expect(test.stderr.join("\n")).not.toContain("\u001b");
  });

  it("refreshes an expiring device credential before a live request", async () => {
    const test = await harness();
    const requests: Array<{ authorization?: string; path: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          ...(request.headers.get("authorization")
            ? { authorization: request.headers.get("authorization")! }
            : {}),
        });
        if (path === "/v1/device-authorizations/token") {
          expect(await request.json()).toEqual({ refreshToken: "refresh-token" });
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
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );

    expect(
      await runCli(["whoami", "--live", "--api-url", server.url.toString(), "--json"], {
        ...test,
        env: { ...test.env, DEPLOYMENTS_API_KEY: "ignored-ambient-key" },
      }),
    ).toBe(0);
    expect(requests).toEqual([
      { path: "/v1/device-authorizations/token" },
      {
        authorization: "Bearer refreshed.payload.signature",
        path: "/v1/whoami",
      },
      {
        authorization: "Bearer refreshed.payload.signature",
        path: "/v1/whoami",
      },
    ]);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiKey: "refreshed.payload.signature",
        apiKeyExpiresAt: expect.any(String),
        refreshToken: "rotated-refresh-token",
      },
    );
  });

  it("does not persist a refreshed bearer rejected by identity validation", async () => {
    const test = await harness();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/device-authorizations/token") {
          return Response.json({
            bearerToken: "untrusted.payload.signature",
            expiresIn: 3600,
            refreshToken: "rotated-refresh-token",
            tokenType: "Bearer",
          });
        }
        return Response.json({ title: "Unauthorized" }, { status: 401 });
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );
    expect(await runCli(["whoami", "--live", "--json"], test)).toBe(3);
    const profile = JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default;
    expect([profile.apiKey, profile.refreshToken, profile.credentialState]).toEqual([
      "expired.payload.signature",
      "rotated-refresh-token",
      undefined,
    ]);
  });

  it("fails locally when an interrupted refresh left the profile fenced", async () => {
    const test = await harness();
    await updateProfile(
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

    expect(await runCli(["whoami", "--live", "--json"], test)).toBe(3);
    expect(test.stderr.join("\n")).toContain("deployments auth login");
  });

  it("marks the profile for reauthentication after a definitive refresh rejection", async () => {
    const test = await harness();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(
          { code: "invalid_grant", detail: "Refresh token is invalid." },
          { status: 400 },
        );
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );

    expect(await runCli(["whoami", "--live", "--json"], test)).toBe(3);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      { credentialState: "reauthentication-required" },
    );
    expect(test.stderr.join("\n")).toContain("deployments auth login");
  });

  it("serializes refresh-token rotation across concurrent CLI requests", async () => {
    const test = await harness();
    let refreshRequests = 0;
    let releaseFirstRefresh!: () => void;
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/device-authorizations/token") {
          refreshRequests += 1;
          if (refreshRequests === 1) {
            markFirstRefreshStarted();
            await firstRefreshReleased;
          }
          return Response.json({
            bearerToken: `refreshed-${refreshRequests}.payload.signature`,
            expiresIn: 3600,
            refreshToken: `rotated-refresh-token-${refreshRequests}`,
            tokenType: "Bearer",
          });
        }
        return Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" });
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );

    const first = runCli(["whoami", "--live", "--json"], test);
    await firstRefreshStarted;
    const second = runCli(["whoami", "--live", "--json"], test);
    await Bun.sleep(25);
    releaseFirstRefresh();

    expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(refreshRequests).toBe(1);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiKey: "refreshed-1.payload.signature",
        refreshToken: "rotated-refresh-token-1",
      },
    );
  });

  it("bounds a stalled device refresh sequence", async () => {
    const test = await harness(false);
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );

    const outcome = await Promise.race([
      resolveContext({}, test.env, {
        deviceRefreshTimeoutMs: 5,
        refreshDeviceCredential: true,
      }).then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(250).then(() => "timed-out"),
    ]);

    expect(outcome).toBe("rejected");
  });

  it("shows expired device context without refreshing or mutating the profile", async () => {
    const test = await harness(false);
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return Response.json({ title: "Unexpected request" }, { status: 500 });
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );
    const before = await readFile(configPath(test.env), "utf8");

    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(requests).toBe(0);
    expect(await readFile(configPath(test.env), "utf8")).toBe(before);
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("apiKey");
  });

  it("keeps public API requests independent of expired device refresh", async () => {
    const test = await harness();
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({ status: "ok" });
      },
    });
    temporaryServers.push(server);
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "revoked-refresh-token",
      },
      test.env,
    );

    expect(await runCli(["health", "--live", "--json"], test)).toBe(0);
    expect(await runCli(["openapi", "--live", "--json"], test)).toBe(0);
    expect(paths).toEqual(["/health", "/v1/openapi.json"]);
  });
});
