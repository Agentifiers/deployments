import { describe, expect, test } from "bun:test";
import { parseCli } from "../cli.ts";

const digest = "ab".repeat(32);
const otherDigest = "cd".repeat(32);

describe("release registry command line", () => {
  test("parses publish with its optional CI run and pinned deployer image", () => {
    expect(
      parseCli([
        "release",
        "publish",
        "--bundle",
        ".artifacts/deployment",
        "--bucket",
        "releases",
        "--ci-run-id",
        "37877507979",
        "--deployer-image",
        `registry/deployer@sha256:${digest}`,
      ]),
    ).toEqual({
      bucket: "releases",
      bundle: ".artifacts/deployment",
      ciRunId: 37877507979,
      deployerImage: `registry/deployer@sha256:${digest}`,
      kind: "release-publish",
    });
    expect(() =>
      parseCli([
        "release",
        "publish",
        "--bundle",
        "b",
        "--bucket",
        "r",
        "--deployer-image",
        "registry/deployer:latest",
      ]),
    ).toThrow("--deployer-image must be pinned by digest");
    expect(() =>
      parseCli(["release", "publish", "--bundle", "b", "--bucket", "r", "--ci-run-id", "0"]),
    ).toThrow("--ci-run-id must be a positive integer.");
  });

  test("parses fetch, retain, rollback-check and both verify sources", () => {
    expect(
      parseCli([
        "release",
        "fetch",
        "--bucket",
        "releases",
        "--release",
        digest,
        "--bundle",
        "out",
        "--profile",
        "platform-prod",
      ]),
    ).toEqual({
      bucket: "releases",
      bundle: "out",
      kind: "release-fetch",
      profile: "platform-prod",
      release: digest,
    });
    expect(parseCli(["release", "retain", "--bucket", "releases", "--release", digest])).toEqual({
      bucket: "releases",
      kind: "release-retain",
      release: digest,
    });
    expect(
      parseCli([
        "release",
        "rollback-check",
        "--bucket",
        "releases",
        "--from",
        digest,
        "--to",
        otherDigest,
      ]),
    ).toEqual({
      bucket: "releases",
      from: digest,
      kind: "release-rollback-check",
      to: otherDigest,
    });
    expect(parseCli(["release", "verify", "--bundle", "out"])).toEqual({
      kind: "release-verify",
      source: { bundle: "out", kind: "bundle" },
    });
    expect(parseCli(["release", "verify", "--bucket", "releases", "--release", digest])).toEqual({
      kind: "release-verify",
      source: { bucket: "releases", kind: "registry", release: digest },
    });
    expect(parseCli(["help"])).toEqual({ kind: "help" });
  });

  test("rejects malformed digests, unknown profiles, and an ambiguous verify", () => {
    expect(() =>
      parseCli(["release", "retain", "--bucket", "releases", "--release", "abc"]),
    ).toThrow("--release must be a release digest, the 64-hex SHA-256 of release.json.");
    expect(() =>
      parseCli([
        "release",
        "fetch",
        "--bucket",
        "r",
        "--release",
        digest,
        "--bundle",
        "out",
        "--profile",
        "prod",
      ]),
    ).toThrow("--profile must be one of platform-dev, platform-prod, platform-customer.");
    expect(() =>
      parseCli([
        "release",
        "verify",
        "--bundle",
        "out",
        "--bucket",
        "releases",
        "--release",
        digest,
      ]),
    ).toThrow("release verify takes --bundle or --bucket with --release, not both.");
    expect(() => parseCli(["release", "fetch", "--release", digest, "--bundle", "out"])).toThrow(
      "--bucket <name> is required.",
    );
  });
});
