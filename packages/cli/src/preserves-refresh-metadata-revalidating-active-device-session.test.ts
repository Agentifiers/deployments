import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { configPath, resolveContext, updateProfile } from "./config.ts";
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

function startAuthServer() {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/v1/whoami") {
        return Response.json({ title: "Not found" }, { status: 404 });
      }
      return Response.json({ id: "account_test", status: "active" });
    },
  });
  temporaryServers.push(server);
  return server;
}

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
  it("preserves refresh metadata when revalidating an active device session", async () => {
    const test = await harness(false);
    const server = startAuthServer();
    await updateProfile(
      "default",
      {
        apiKey: "active.payload.signature",
        apiKeyExpiresAt: "2099-01-01T00:00:00.000Z",
        apiUrl: server.url.toString(),
        mock: false,
        refreshToken: "refresh-token",
      },
      test.env,
    );

    expect(
      await runCli(["auth", "login", "--live", "--api-url", server.url.toString()], test),
    ).toBe(0);
    expect(
      await runCli(["auth", "login", "--mock", "--api-url", server.url.toString()], test),
    ).toBe(0);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiKey: "active.payload.signature",
        apiKeyExpiresAt: "2099-01-01T00:00:00.000Z",
        refreshToken: "refresh-token",
      },
    );
  });

  it("persists environment-provided login credentials against their API origin", async () => {
    const test = await harness(false);
    const server = startAuthServer();
    const env = {
      ...test.env,
      DEPLOYMENTS_API_KEY: "dpl_environment_key",
      DEPLOYMENTS_API_URL: server.url.toString(),
      DEPLOYMENTS_LIVE: "1",
    };

    expect(await runCli(["auth", "login", "--json"], { ...test, env })).toBe(0);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiUrl: server.url.toString(),
        apiKey: "dpl_environment_key",
        mock: false,
      },
    );
    expect(await resolveContext({}, test.env)).toMatchObject({
      apiUrl: server.url.toString(),
      apiKey: "dpl_environment_key",
    });
  });

  it("honors DEPLOYMENTS_PROFILE for every profile mutation", async () => {
    const baseConfig = {
      version: 1,
      currentProfile: "default",
      profiles: {
        default: {
          apiUrl: "https://api.example.test",
          apiKey: "dpl_default_key",
          organizationId: "org_default",
          projectId: "prj_default",
          mock: true,
        },
        staging: {
          apiUrl: "https://api.example.test",
          apiKey: "dpl_staging_key",
          organizationId: "org_staging",
          projectId: "prj_staging",
          mock: true,
        },
      },
    };

    const login = await harness();
    expect(await runCli(["context", "set", "--org", "bootstrap", "--json"], login)).toBe(0);
    await writeFile(configPath(login.env), `${JSON.stringify(baseConfig, null, 2)}\n`);
    expect(
      await runCli(["auth", "login", "--json"], {
        ...login,
        env: { ...login.env, DEPLOYMENTS_PROFILE: "staging" },
      }),
    ).toBe(0);
    expect(JSON.parse(await readFile(configPath(login.env), "utf8")).currentProfile).toBe(
      "staging",
    );

    const logout = await harness();
    expect(await runCli(["context", "set", "--org", "bootstrap", "--json"], logout)).toBe(0);
    await writeFile(configPath(logout.env), `${JSON.stringify(baseConfig, null, 2)}\n`);
    expect(
      await runCli(["auth", "logout", "--json"], {
        ...logout,
        env: { ...logout.env, DEPLOYMENTS_PROFILE: "staging" },
      }),
    ).toBe(0);
    const loggedOut = JSON.parse(await readFile(configPath(logout.env), "utf8"));
    expect(loggedOut.profiles.default.apiKey).toBe("dpl_default_key");
    expect(loggedOut.profiles.staging.apiKey).toBeUndefined();

    const set = await harness();
    expect(await runCli(["context", "set", "--org", "bootstrap", "--json"], set)).toBe(0);
    await writeFile(configPath(set.env), `${JSON.stringify(baseConfig, null, 2)}\n`);
    expect(
      await runCli(["context", "set", "--org", "org_updated", "--json"], {
        ...set,
        env: { ...set.env, DEPLOYMENTS_PROFILE: "staging" },
      }),
    ).toBe(0);
    const updated = JSON.parse(await readFile(configPath(set.env), "utf8"));
    expect(updated.profiles.default.organizationId).toBe("org_default");
    expect(updated.profiles.staging.organizationId).toBe("org_updated");

    const clear = await harness();
    expect(await runCli(["context", "set", "--org", "bootstrap", "--json"], clear)).toBe(0);
    await writeFile(configPath(clear.env), `${JSON.stringify(baseConfig, null, 2)}\n`);
    expect(
      await runCli(["context", "clear", "--json"], {
        ...clear,
        env: { ...clear.env, DEPLOYMENTS_PROFILE: "staging" },
      }),
    ).toBe(0);
    const cleared = JSON.parse(await readFile(configPath(clear.env), "utf8"));
    expect(cleared.profiles.default.organizationId).toBe("org_default");
    expect(cleared.profiles.staging).not.toHaveProperty("organizationId");
    expect(cleared.profiles.staging).not.toHaveProperty("projectId");
  });

  it("does not resolve inherited object properties as profiles", async () => {
    const test = await harness();
    expect(await resolveContext({ profile: "constructor" }, test.env)).toMatchObject({
      profileName: "constructor",
      apiUrl: "https://api.us.deployments.ai",
      mock: true,
    });
  });

  it("never promotes the generated mock credential into live mode", async () => {
    const test = await harness();
    expect(await runCli(["auth", "login", "--json"], test)).toBe(0);
    let config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    expect(config.profiles.default).toMatchObject({ apiKey: "dpl_mock_session", mock: true });

    test.stdout.length = 0;
    expect(await runCli(["auth", "login", "--live", "--json"], test)).toBe(8);
    config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    expect(config.profiles.default).toMatchObject({ apiKey: "dpl_mock_session", mock: true });

    expect(await runCli(["context", "set", "--live", "--json"], test)).toBe(0);
    config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    expect(config.profiles.default.mock).toBe(false);
    expect(config.profiles.default.apiKey).toBeUndefined();
    expect(await resolveContext({}, test.env)).not.toHaveProperty("apiKey");
  });

  it("binds stored credentials to their configured API origin", async () => {
    const test = await harness();
    const server = startAuthServer();
    expect(
      await runCli(
        [
          "auth",
          "login",
          "--live",
          "--api-url",
          server.url.toString(),
          "--api-key",
          "dpl_primary_key",
          "--json",
        ],
        test,
      ),
    ).toBe(0);

    expect(
      await resolveContext({ apiUrl: "https://override.example.test", live: true }, test.env),
    ).not.toHaveProperty("apiKey");
    expect(
      await resolveContext(
        { live: true },
        { ...test.env, DEPLOYMENTS_API_URL: "https://environment.example.test" },
      ),
    ).not.toHaveProperty("apiKey");
    expect(
      await resolveContext(
        { apiUrl: "https://override.example.test", live: true },
        { ...test.env, DEPLOYMENTS_API_KEY: "dpl_ambient_key" },
      ),
    ).not.toHaveProperty("apiKey");
    expect(
      await resolveContext(
        { apiUrl: server.url.toString(), live: true },
        {
          ...test.env,
          DEPLOYMENTS_API_URL: "https://environment.example.test",
          DEPLOYMENTS_API_KEY: "dpl_ambient_key",
        },
      ),
    ).toMatchObject({ apiKey: "dpl_primary_key" });
    expect(
      await resolveContext(
        {
          apiUrl: "https://override.example.test",
          apiKey: "dpl_override_key",
          live: true,
        },
        test.env,
      ),
    ).toMatchObject({ apiKey: "dpl_override_key" });

    test.stdout.length = 0;
    test.stderr.length = 0;
    expect(
      await runCli(
        ["auth", "login", "--live", "--api-url", "https://other.example.test", "--json"],
        test,
      ),
    ).toBe(8);
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiUrl: server.url.toString(),
        apiKey: "dpl_primary_key",
      },
    );

    test.stdout.length = 0;
    test.stderr.length = 0;
    expect(
      await runCli(["context", "set", "--api-url", "https://other.example.test", "--json"], test),
    ).toBe(0);
    expect(
      JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default,
    ).not.toHaveProperty("apiKey");
  });

  it("loads login secrets from files or named environment variables", async () => {
    const test = await harness(false);
    const server = startAuthServer();
    const apiKeyFile = join(test.directory, "api-key.txt");
    await writeFile(apiKeyFile, "dpl_file_key\n", { mode: 0o600 });
    expect(
      await runCli(
        [
          "auth",
          "login",
          "--live",
          "--api-url",
          server.url.toString(),
          "--api-key-file",
          apiKeyFile,
          "--json",
        ],
        test,
      ),
    ).toBe(0);
    const config = JSON.parse(await readFile(configPath(test.env), "utf8"));
    expect(config.profiles.default.apiKey).toBe("dpl_file_key");
    expect(config.profiles.default.mock).toBe(false);

    test.stdout.length = 0;
    expect(await runCli(["auth", "login", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!).mode).toBe("live");
    expect(JSON.parse(await readFile(configPath(test.env), "utf8")).profiles.default).toMatchObject(
      {
        apiKey: "dpl_file_key",
        mock: false,
      },
    );

    const environmentLogin = await harness(false);
    expect(
      await runCli(["auth", "login", "--json"], {
        ...environmentLogin,
        env: {
          ...environmentLogin.env,
          DEPLOYMENTS_LIVE: "1",
          DEPLOYMENTS_API_KEY: "dpl_environment_key",
          DEPLOYMENTS_API_URL: server.url.toString(),
        },
      }),
    ).toBe(0);
    expect(
      JSON.parse(await readFile(configPath(environmentLogin.env), "utf8")).profiles.default,
    ).toMatchObject({ apiKey: "dpl_environment_key", mock: false });
  });

  it("validates live credentials before persisting or reporting authentication", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(
          { title: "Unauthorized", detail: "invalid dpl_rejected_key" },
          { status: 401, headers: { "x-request-id": "req_auth" } },
        );
      },
    });
    temporaryServers.push(server);
    const test = await harness();

    expect(
      await runCli(
        [
          "auth",
          "login",
          "--live",
          "--api-url",
          server.url.toString(),
          "--api-key",
          "dpl_rejected_key",
          "--json",
        ],
        test,
      ),
    ).toBe(3);
    expect(test.stdout).toEqual([]);
    expect(test.stderr.join("\n")).not.toContain("dpl_rejected_key");
    expect(await resolveContext({}, test.env)).not.toHaveProperty("apiKey");

    const invalidIdentityServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({});
      },
    });
    temporaryServers.push(invalidIdentityServer);
    const invalidIdentity = await harness();
    expect(
      await runCli(
        [
          "auth",
          "login",
          "--live",
          "--api-url",
          invalidIdentityServer.url.toString(),
          "--api-key",
          "dpl_key",
          "--json",
        ],
        invalidIdentity,
      ),
    ).toBe(8);
    expect(await resolveContext({}, invalidIdentity.env)).not.toHaveProperty("apiKey");
  });

  it("honors quiet output on custom commands", async () => {
    for (const command of [
      ["auth", "login", "--quiet"],
      ["context", "show", "--quiet"],
      ["context", "set", "--org", "org_1", "--quiet"],
      ["context", "clear", "--quiet"],
      ["catalog", "--quiet"],
    ]) {
      const test = await harness();
      expect(await runCli(command, test)).toBe(0);
      expect(test.stdout).toEqual([]);
    }
  });

  it("reads JSON and NDJSON memory imports from local files", async () => {
    const test = await harness();
    const importFile = join(test.directory, "memory.ndjson");
    await writeFile(importFile, '{"content":"first"}\n{"content":"second"}\n');
    expect(
      await runCli(
        [
          "memory",
          "import",
          "--space",
          "memory_space_1",
          "--file",
          importFile,
          "--json",
          "--reveal",
        ],
        test,
      ),
    ).toBe(0);
    const imported = JSON.parse(test.stdout[0]!);
    expect(imported.imported).toHaveLength(1);
    expect(JSON.stringify(imported)).not.toContain("first");
    expect(JSON.stringify(imported)).not.toContain("second");

    const conflict = await harness();
    expect(
      await runCli(
        ["memory", "import", "--space", "memory_space_1", "--file", importFile, "--data", "[]"],
        conflict,
      ),
    ).toBe(2);
  });
});
