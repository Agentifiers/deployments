import { describe, expect, it } from "bun:test";
import { CliError, ExitCode } from "../errors.ts";
import { runCli } from "../cli.ts";
import type { CliIo } from "../types.ts";
import { parseDevOptions } from "./args.ts";

function rejection(args: Record<string, unknown>): CliError {
  try {
    parseDevOptions(args);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("Expected parseDevOptions to reject.");
}

describe("deployments dev arguments", () => {
  it("defaults to interactive mode with the default runtime configuration", () => {
    expect(parseDevOptions({ manifest: "agent.json" })).toEqual({
      manifestPath: "agent.json",
      runtimeConfig: { type: "default" },
    });
  });

  it("selects one-shot mode, a runtime configuration file, and a TTL", () => {
    expect(
      parseDevOptions({
        manifest: "agent.json",
        message: "hello",
        "runtime-config": "config.json",
        ttl: "3600",
      }),
    ).toEqual({
      manifestPath: "agent.json",
      message: "hello",
      runtimeConfig: { type: "file", path: "config.json" },
      ttlSeconds: 3600,
    });
    expect(
      parseDevOptions({ manifest: "agent.json", configFromDeployment: "deployment_1" })
        .runtimeConfig,
    ).toEqual({ type: "deployment", agentDeploymentId: "deployment_1" });
  });

  it("rejects combining a runtime configuration file with a deployment snapshot", () => {
    const error = rejection({
      manifest: "agent.json",
      "runtime-config": "config.json",
      "config-from-deployment": "deployment_1",
    });
    expect(error.exitCode).toBe(ExitCode.usage);
    expect(error.message).toContain("mutually exclusive");
  });

  it("accepts the TTL bounds and rejects values outside them", () => {
    expect(parseDevOptions({ manifest: "a.json", ttl: "60" }).ttlSeconds).toBe(60);
    expect(parseDevOptions({ manifest: "a.json", ttl: "604800" }).ttlSeconds).toBe(604_800);
    for (const ttl of ["59", "604801", "90.5", "1e3", "-60", "soon"]) {
      expect(rejection({ manifest: "a.json", ttl }).exitCode).toBe(ExitCode.validation);
    }
  });

  it("rejects an empty message", () => {
    expect(rejection({ manifest: "a.json", message: "  " }).message).toBe(
      "--message must not be empty.",
    );
  });

  it("fails before any request when both configuration sources are passed", async () => {
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: () => {},
      stderr: (value) => stderr.push(value),
      isInteractive: false,
    };
    const exitCode = await runCli(
      [
        "dev",
        "agent.json",
        "--runtime-config",
        "config.json",
        "--config-from-deployment",
        "deployment_1",
        "--api-url",
        "http://127.0.0.1:9",
        "--api-key",
        "key",
        "--env",
        "env_1",
      ],
      { io, env: { NO_COLOR: "1", DEPLOYMENTS_CONFIG_DIR: "/nonexistent-deployments-config" } },
    );
    expect(exitCode).toBe(ExitCode.usage);
    expect(stderr.join("\n")).toContain("mutually exclusive");
  });
});
