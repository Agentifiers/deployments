import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PublicId } from "@deployments-ai/api-contract";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { deploymentArtifacts } from "../build-deployment-artifacts.ts";
import { DeployEvent, deployEventFile, deployRun } from "./deploy-events.ts";
import { publishLambdaArtifacts } from "./lambda-artifacts.ts";
import { type CommandRunner, CommandFailure } from "./process.ts";
import type { VerifiedRelease } from "./release-bundle.ts";
import { readSigningPublicKey } from "./release-registry/signing.ts";

const at = "2026-10-09T04:02:10.000Z";
const clock = () => new Date(at);
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function eventsPath() {
  const directory = mkdtempSync(join(tmpdir(), "platform-events-"));
  directories.push(directory);
  return join(directory, "events.jsonl");
}

function decodedLines(path: string) {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(DeployEvent)(JSON.parse(line)));
}

describe("deploy events", () => {
  test("reports a preflight failure once and appends to an existing file", () => {
    const path = eventsPath();
    writeFileSync(path, "earlier\n");
    const run = deployRun(deployEventFile(path, clock));
    run.failOnce(new Error("Release bundle is missing\nplatform-api.zip."));
    run.failOnce(new Error("A later layer saw the same failure."));
    expect(readFileSync(path, "utf8")).toBe(
      [
        "earlier",
        '{"version":1,"type":"preflight-failed","at":"2026-10-09T04:02:10.000Z","message":"Release bundle is missing platform-api.zip."}',
        '{"version":1,"type":"finished","at":"2026-10-09T04:02:10.000Z","outcome":"failed"}',
        "",
      ].join("\n"),
    );
  });

  test("reports a stage failure after started without a preflight failure", async () => {
    const path = eventsPath();
    const run = deployRun(deployEventFile(path, clock));
    run.start({ releaseManifestSha256: "5".repeat(64), sourceCommit, target: "acme" });
    expect(await run.runStage("callerAccount", async () => "123456789012")).toBe("123456789012");
    const failure = new Error("tofu init failed: backend unreachable");
    expect(
      run.runStage("init", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    run.failOnce(failure);
    expect(decodedLines(path)).toEqual([
      {
        at,
        releaseManifestSha256: "5".repeat(64),
        sourceCommit,
        target: "acme",
        type: "started",
        version: 1,
      },
      { at, stage: "callerAccount", type: "stage-started", version: 1 },
      { at, stage: "callerAccount", type: "stage-succeeded", version: 1 },
      { at, stage: "init", type: "stage-started", version: 1 },
      {
        at,
        message: "tofu init failed: backend unreachable",
        stage: "init",
        type: "stage-failed",
        version: 1,
      },
      { at, outcome: "failed", type: "finished", version: 1 },
    ]);
  });

  test("reports the recorded installation without its storage fields, then finishes", () => {
    const path = eventsPath();
    const run = deployRun(deployEventFile(path, clock));
    run.start({ releaseManifestSha256: "5".repeat(64), sourceCommit, target: "acme" });
    run.succeed({
      awsAccountId: "123456789012",
      awsRegion: "us-east-2",
      createdAt: "2026-10-01T00:00:00.000Z",
      deployedAt: at,
      deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
      deploymentId: Schema.decodeUnknownSync(Ulid)("01K7ABCDEFGHJKMNPQRSTVWXYZ"),
      endpoints: [],
      id: "current",
      images: [],
      lambdaArtifacts: [],
      profile: "platform-prod",
      releaseManifestSha256: "5".repeat(64),
      sourceCommit,
      targetName: "acme",
      updatedAt: at,
      version: 4,
    });
    run.failOnce(new Error("Writing --result failed."));
    expect(decodedLines(path).slice(1)).toEqual([
      {
        at,
        installation: {
          awsAccountId: "123456789012",
          awsRegion: "us-east-2",
          deployedAt: at,
          deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
          deploymentId: Schema.decodeUnknownSync(PublicId)("01K7ABCDEFGHJKMNPQRSTVWXYZ"),
          endpoints: [],
          images: [],
          lambdaArtifacts: [],
          profile: "platform-prod",
          releaseManifestSha256: "5".repeat(64),
          sourceCommit,
          targetName: "acme",
          updatedAt: at,
          version: 4,
        },
        type: "recorded",
        version: 1,
      },
      { at, outcome: "succeeded", type: "finished", version: 1 },
    ]);
  });

  test("records a stage failure's error name and every cause on one line", async () => {
    const path = eventsPath();
    const run = deployRun(deployEventFile(path, clock));
    run.start({ releaseManifestSha256: "5".repeat(64), sourceCommit, target: "acme" });
    const archive = join(dirname(path), "artifact.zip");
    writeFileSync(archive, "zip");
    const release = {
      artifacts: Object.fromEntries(
        Object.keys(deploymentArtifacts).map((name) => [
          name,
          { path: archive, sha256: "a".repeat(64) },
        ]),
      ),
    } as unknown as VerifiedRelease;
    const s3: CommandRunner = async (command) => {
      if (command.includes("head-object")) {
        throw new CommandFailure(
          "An error occurred (404) when calling the HeadObject operation: Not Found",
          command,
        );
      }
      return "<html>Service Unavailable</html>";
    };
    const failure = await run
      .runStage("publishLambdaArtifacts", () =>
        publishLambdaArtifacts({
          bucket: "artifacts",
          kmsKeyArn: "arn:aws:kms:us-east-2:1:key/k",
          release,
          run: s3,
        }),
      )
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Unable to decode S3 put-object.");
    expect(decodedLines(path).at(-1)).toEqual({
      at,
      message:
        "Unable to decode S3 put-object. Caused by: SyntaxError: JSON Parse error: Unrecognized token '<'",
      stage: "publishLambdaArtifacts",
      type: "stage-failed",
      version: 1,
    });
  });

  test("records a preflight failure's cause on one line", async () => {
    const path = eventsPath();
    const key = join(dirname(path), "missing.pem");
    const failure = await readSigningPublicKey(key).catch((error: unknown) => error);
    deployRun(deployEventFile(path, clock)).failOnce(failure);
    expect(decodedLines(path)[0]).toEqual({
      at,
      message: `Unable to read the release signing public key ${key}. Caused by: ENOENT: no such file or directory, open '${key}'`,
      type: "preflight-failed",
      version: 1,
    });
  });
});
