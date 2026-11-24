import { PlatformTransportError } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { runCli } from "./cli.ts";
import { configPath, readConfig, replaceProfile, resolveContext, updateProfile } from "./config.ts";
import { exitCodeForError } from "./errors.ts";
import { defaultConfig } from "./profile-resolution-helpers.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";

afterEach(removeTemporaryDirectories);

describe("CLI configuration and output", () => {
  it("defaults release profiles to live mode", () => {
    expect(defaultConfig().profiles.default?.mock).toBe(false);
  });

  it("keeps missing and newly created profiles in live mode by default", async () => {
    const test = await harness();
    const liveEnv = { DEPLOYMENTS_CONFIG_DIR: test.directory, NO_COLOR: "1" };

    expect(await resolveContext({ profile: "missing" }, liveEnv)).toMatchObject({
      apiUrl: "https://api.us.deployments.ai",
      mock: false,
      profileName: "missing",
    });

    await updateProfile("updated", { organizationId: "org_updated" }, liveEnv);
    expect((await readConfig(liveEnv)).profiles.updated).toMatchObject({
      apiUrl: "https://api.us.deployments.ai",
      mock: false,
      organizationId: "org_updated",
    });

    await replaceProfile(
      "replaced",
      (current) => ({
        ...current,
        projectId: "prj_replaced",
      }),
      liveEnv,
    );
    expect((await readConfig(liveEnv)).profiles.replaced).toMatchObject({
      apiUrl: "https://api.us.deployments.ai",
      mock: false,
      projectId: "prj_replaced",
    });
  });

  it("clears descendant context when a parent context changes", async () => {
    const test = await harness();
    expect(
      await runCli(
        [
          "context",
          "set",
          "--org",
          "org_1",
          "--project",
          "prj_1",
          "--env",
          "env_1",
          "--workspace",
          "workspace_1",
          "--json",
        ],
        test,
      ),
    ).toBe(0);
    expect(await runCli(["context", "set", "--org", "org_1", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      organizationId: "org_1",
      projectId: "prj_1",
      environmentId: "env_1",
      workspaceId: "workspace_1",
    });

    expect(await runCli(["context", "set", "--org", "org_2", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({ organizationId: "org_2" });
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("projectId");
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("environmentId");
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("workspaceId");

    expect(
      await runCli(
        [
          "context",
          "set",
          "--project",
          "prj_2",
          "--env",
          "env_2",
          "--workspace",
          "workspace_2",
          "--json",
        ],
        test,
      ),
    ).toBe(0);
    expect(await runCli(["context", "set", "--project", "prj_2", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({
      projectId: "prj_2",
      environmentId: "env_2",
      workspaceId: "workspace_2",
    });

    expect(await runCli(["context", "set", "--project", "prj_3", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({ projectId: "prj_3" });
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("environmentId");
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("workspaceId");

    expect(
      await runCli(
        ["context", "set", "--env", "env_3", "--workspace", "workspace_3", "--json"],
        test,
      ),
    ).toBe(0);
    expect(await runCli(["context", "set", "--env", "env_4", "--json"], test)).toBe(0);
    test.stdout.length = 0;
    expect(await runCli(["context", "show", "--json"], test)).toBe(0);
    expect(JSON.parse(test.stdout[0]!)).toMatchObject({ environmentId: "env_4" });
    expect(JSON.parse(test.stdout[0]!)).not.toHaveProperty("workspaceId");
  });

  it("persists environment-selected parents when setting descendant context", async () => {
    const test = await harness();
    expect(
      await runCli(
        ["context", "set", "--org", "org_old", "--project", "prj_old", "--env", "env_old"],
        test,
      ),
    ).toBe(0);

    expect(
      await runCli(["context", "set", "--project", "prj_new", "--json"], {
        ...test,
        env: { ...test.env, DEPLOYMENTS_ORG: "org_new" },
      }),
    ).toBe(0);
    expect(await resolveContext({}, test.env)).toMatchObject({
      organizationId: "org_new",
      projectId: "prj_new",
    });
    expect(await resolveContext({}, test.env)).not.toHaveProperty("environmentId");

    expect(
      await runCli(["context", "set", "--env", "env_new", "--json"], {
        ...test,
        env: { ...test.env, DEPLOYMENTS_PROJECT: "prj_environment" },
      }),
    ).toBe(0);
    expect(await resolveContext({}, test.env)).toMatchObject({
      organizationId: "org_new",
      projectId: "prj_environment",
      environmentId: "env_new",
    });

    const workspaceTest = await harness();
    expect(
      await runCli(["context", "set", "--workspace", "workspace_new", "--json"], {
        ...workspaceTest,
        env: {
          ...workspaceTest.env,
          DEPLOYMENTS_ENVIRONMENT: "env_workspace",
          DEPLOYMENTS_ORG: "org_workspace",
          DEPLOYMENTS_PROJECT: "prj_workspace",
        },
      }),
    ).toBe(0);
    expect(await resolveContext({}, workspaceTest.env)).toMatchObject({
      environmentId: "env_workspace",
      organizationId: "org_workspace",
      projectId: "prj_workspace",
      workspaceId: "workspace_new",
    });
  });

  it("drops stale descendants for transient parent overrides", async () => {
    const test = await harness();
    expect(
      await runCli(
        [
          "context",
          "set",
          "--org",
          "org_1",
          "--project",
          "prj_1",
          "--env",
          "env_1",
          "--workspace",
          "workspace_1",
          "--json",
        ],
        test,
      ),
    ).toBe(0);
    expect(await resolveContext({ org: "org_2" }, test.env)).toMatchObject({
      organizationId: "org_2",
    });
    expect(await resolveContext({ org: "org_2" }, test.env)).not.toHaveProperty("projectId");
    expect(await resolveContext({ org: "org_2" }, test.env)).not.toHaveProperty("environmentId");
    expect(await resolveContext({ org: "org_2" }, test.env)).not.toHaveProperty("workspaceId");
    expect(await resolveContext({ project: "prj_2", env: "env_2" }, test.env)).not.toHaveProperty(
      "workspaceId",
    );
    expect(await resolveContext({ env: "env_2" }, test.env)).not.toHaveProperty("workspaceId");
    expect(
      await resolveContext({ env: "env_2", workspace: "workspace_2" }, test.env),
    ).toMatchObject({ environmentId: "env_2", workspaceId: "workspace_2" });
    expect(
      await resolveContext(
        { org: "org_flag", project: "prj_flag" },
        { ...test.env, DEPLOYMENTS_ORG: "org_environment", DEPLOYMENTS_ENVIRONMENT: "env_stale" },
      ),
    ).toMatchObject({ organizationId: "org_flag", projectId: "prj_flag" });
    expect(
      await resolveContext(
        { org: "org_flag", project: "prj_flag" },
        { ...test.env, DEPLOYMENTS_ORG: "org_environment", DEPLOYMENTS_ENVIRONMENT: "env_stale" },
      ),
    ).not.toHaveProperty("environmentId");
  });

  it("lets an explicit mock flag override a live environment default", async () => {
    const test = await harness();
    const env = { ...test.env, DEPLOYMENTS_LIVE: "1" };
    expect(await runCli(["project", "list", "--mock", "--json"], { ...test, env })).toBe(0);
    expect(JSON.parse(test.stdout[0]!).items).toHaveLength(2);
  });

  it("rejects contradictory environment transport modes", async () => {
    const test = await harness();
    expect(
      await runCli(["health", "--no-color"], {
        ...test,
        env: { ...test.env, DEPLOYMENTS_MOCK: "1", DEPLOYMENTS_LIVE: "1" },
      }),
    ).toBe(2);
    expect(test.stderr.join("\n")).toContain(
      "Choose either DEPLOYMENTS_MOCK=1 or DEPLOYMENTS_LIVE=1",
    );

    const persisted = await harness();
    expect(
      await runCli(
        ["context", "set", "--org", "org_1", "--project", "prj_1", "--env", "env_1", "--json"],
        persisted,
      ),
    ).toBe(0);
    const before = await readFile(configPath(persisted.env), "utf8");
    persisted.stdout.length = 0;
    persisted.stderr.length = 0;
    expect(
      await runCli(["context", "set", "--org", "org_2", "--json"], {
        ...persisted,
        env: { ...persisted.env, DEPLOYMENTS_MOCK: "1", DEPLOYMENTS_LIVE: "1" },
      }),
    ).toBe(2);
    expect(await readFile(configPath(persisted.env), "utf8")).toBe(before);

    for (const [key, value] of [
      ["DEPLOYMENTS_ORG", " "],
      ["DEPLOYMENTS_PROJECT", " project "],
      ["DEPLOYMENTS_ENVIRONMENT", ""],
      ["DEPLOYMENTS_WORKSPACE", " workspace "],
      ["DEPLOYMENTS_API_URL", " https://api.example.test"],
      ["DEPLOYMENTS_API_KEY", " key "],
    ] as const) {
      const malformed = await harness();
      expect(
        await runCli(["health", "--json"], {
          ...malformed,
          env: { ...malformed.env, [key]: value },
        }),
      ).toBe(7);
      expect(malformed.stderr.join("\n")).toContain(`${key} must be a non-empty, unpadded value`);
    }
  });

  it("rejects malformed API URLs before profile persistence or transport", async () => {
    const context = await harness();
    expect(await runCli(["context", "set", "--api-url", "not-a-url", "--json"], context)).toBe(7);
    expect(context.stderr.join("\n")).toContain("Invalid platform API URL");

    const command = await harness();
    expect(
      await runCli(["health", "--live", "--api-url", "not-a-url", "--no-color"], command),
    ).toBe(7);

    const environmentContext = await harness();
    expect(await runCli(["context", "set", "--org", "org_1", "--json"], environmentContext)).toBe(
      0,
    );
    const before = await readFile(configPath(environmentContext.env), "utf8");
    environmentContext.stdout.length = 0;
    environmentContext.stderr.length = 0;
    expect(
      await runCli(["context", "set", "--org", "org_2", "--json"], {
        ...environmentContext,
        env: { ...environmentContext.env, DEPLOYMENTS_API_URL: "not-a-url" },
      }),
    ).toBe(7);
    expect(environmentContext.stderr.join("\n")).toContain("Invalid platform API URL");
    expect(await readFile(configPath(environmentContext.env), "utf8")).toBe(before);

    const cleartextContext = await harness();
    expect(
      await runCli(
        ["context", "set", "--api-url", "http://api.example.test", "--json"],
        cleartextContext,
      ),
    ).toBe(7);

    const cleartextLogin = await harness();
    expect(
      await runCli(
        [
          "auth",
          "login",
          "--live",
          "--api-url",
          "http://api.example.test",
          "--api-key",
          "dpl_secret",
          "--json",
        ],
        cleartextLogin,
      ),
    ).toBe(7);

    const prefixedContext = await harness();
    expect(
      await runCli(
        ["context", "set", "--api-url", "https://api.example.test/prefix", "--json"],
        prefixedContext,
      ),
    ).toBe(7);
  });

  it("uses stable validation and usage exit codes", async () => {
    const live = await harness();
    expect(await runCli(["project", "list", "--live", "--json"], live)).toBe(7);
    expect(live.stderr.join("\n")).toContain("No organization context is configured");

    const usage = await harness();
    expect(await runCli(["project", "create", "--json"], usage)).toBe(2);

    const blankName = await harness();
    expect(await runCli(["project", "create", "--name", "   ", "--json"], blankName)).toBe(7);
    expect(blankName.stderr.join("\n")).toContain("--name must not be empty");

    const blankMessage = await harness();
    expect(await runCli(["chat", "--message", "", "--json"], blankMessage)).toBe(7);
    expect(blankMessage.stderr.join("\n")).toContain("non-empty --message");

    const unscopedChat = await harness();
    expect(await runCli(["chat", "--message", "hello", "--live", "--json"], unscopedChat)).toBe(7);
    expect(unscopedChat.stderr.join("\n")).toContain("No environment context is configured");

    const rejection = await harness();
    expect(
      await runCli(
        [
          "approval",
          "reject",
          "approval_1",
          "--run",
          "run_1",
          "--thread",
          "thread_1",
          "--live",
          "--env",
          "env_1",
        ],
        rejection,
      ),
    ).toBe(2);
    expect(rejection.stderr.join("\n")).toContain("require --yes");

    const conflictingMode = await harness();
    expect(await runCli(["health", "--mock", "--live"], conflictingMode)).toBe(2);
    expect(exitCodeForError(new PlatformTransportError("offline", new Error("refused")))).toBe(8);
    expect(
      exitCodeForError(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    ).toBe(1);

    const unknownOption = await harness();
    expect(await runCli(["health", "--mockk", "--no-color"], unknownOption)).toBe(2);
    expect(unknownOption.stderr.join("\n")).toContain("Unknown option: --mockk");
    expect(unknownOption.stderr.join("\n")).not.toContain("\u001b");

    for (const negatedMode of ["--no-live", "--no-mock"]) {
      const mode = await harness();
      expect(
        await runCli(["health", negatedMode, "--no-color"], {
          ...mode,
          env: { ...mode.env, DEPLOYMENTS_LIVE: "1" },
        }),
      ).toBe(2);
      expect(mode.stderr.join("\n")).toContain(`Unknown option: ${negatedMode}`);
    }

    const booleanAssignment = await harness();
    expect(await runCli(["health", "--reveal=0", "--no-color"], booleanAssignment)).toBe(2);
    expect(booleanAssignment.stderr.join("\n")).toContain(
      "Boolean option does not accept a value: --reveal",
    );

    const surplus = await harness();
    expect(await runCli(["project", "show", "prj_1", "extra", "--no-color"], surplus)).toBe(2);
    expect(surplus.stderr.join("\n")).toContain("Too many positional arguments");

    for (const emptyId of ["", "   "]) {
      const missingId = await harness();
      expect(await runCli(["project", "show", emptyId, "--no-color"], missingId)).toBe(7);
      expect(missingId.stderr.join("\n")).toContain("--id must not be empty");
    }
    for (const dotId of [".", ".."]) {
      const invalidId = await harness();
      expect(await runCli(["project", "show", dotId, "--no-color"], invalidId)).toBe(7);
      expect(invalidId.stderr.join("\n")).toContain("Path argument --id must not be empty");
    }

    for (const invalidPageSize of ["10oops", "1.5", "0", "101"]) {
      const pagination = await harness();
      expect(
        await runCli(["project", "list", "--page-size", invalidPageSize, "--no-color"], pagination),
      ).toBe(7);
      expect(pagination.stderr.join("\n")).toContain(
        "--page-size must be an integer between 1 and 100",
      );
    }

    for (const nonListPagination of [
      ["project", "create", "--name", "Project", "--page-size", "10"],
      ["project", "show", "prj_1", "--cursor", "cursor_1"],
    ]) {
      const pagination = await harness();
      expect(await runCli([...nonListPagination, "--no-color"], pagination)).toBe(2);
      expect(pagination.stderr.join("\n")).toContain("Unknown option");
    }
  });
});
