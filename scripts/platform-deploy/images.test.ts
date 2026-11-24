import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecyclePolicy, publishImages } from "./images.ts";
import { CommandFailure, type CommandRunner, runCommand } from "./process.ts";
import { defaultEcrRepositories } from "./profiles.ts";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const digest = `sha256:${"ab".repeat(32)}`;
const uri = "123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/model-gateway";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

async function imageArchive() {
  const directory = mkdtempSync(join(tmpdir(), "platform-image-"));
  directories.push(directory);
  writeFileSync(join(directory, "index.json"), '{"schemaVersion":2}');
  writeFileSync(join(directory, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  const path = join(directory, "model-gateway.oci.tar");
  await runCommand(["tar", "-cf", path, "-C", directory, "index.json", "oci-layout"]);
  return path;
}

function registry(input: { readonly holds: boolean; readonly pushes: string }) {
  const calls: string[][] = [];
  let scratch = "";
  const run: CommandRunner = async (command, options = {}) => {
    const dockerConfig = options.env?.DOCKER_CONFIG;
    if (dockerConfig) scratch = dockerConfig.replace(/\/docker$/u, "");
    calls.push(command.map((part) => (scratch ? part.replace(scratch, "<scratch>") : part)));
    switch (command.slice(0, 4).join(" ")) {
      case "aws ecr --region us-east-2":
        return `${uri}\n`;
      case "aws ecr put-lifecycle-policy --region":
        return "";
      case "aws ecr describe-images --region":
        if (input.holds) return `IMAGEDETAILS\t${digest}\n`;
        throw new CommandFailure("An error occurred (ImageNotFoundException)", command);
      case "aws ecr get-login-password --region":
        return "ecr-token\n";
      case "crane auth login 123456789012.dkr.ecr.us-east-2.amazonaws.com":
        expect(options.input).toBe("ecr-token\n");
        return "";
      default:
        if (command[0] === "tar") return await runCommand(command);
        if (command[0] === "crane" && command[1] === "push") {
          expect(existsSync(join(command[2]!, "index.json"))).toBe(true);
          return `${uri}@${input.pushes}\n`;
        }
        throw new Error(`unexpected command ${command.join(" ")}`);
    }
  };
  return { calls, run, scratch: () => scratch };
}

async function publish(run: CommandRunner, path: string) {
  return await publishImages({
    environment: { HOME: "/home/deployer" },
    names: ["model-gateway"],
    region: "us-east-2",
    release: {
      images: {
        "model-gateway": {
          digest,
          file: "images/model-gateway.oci.tar",
          path,
          platform: "linux/arm64",
          sha256: "1".repeat(64),
        },
      },
      sourceCommit,
    },
    repositories: defaultEcrRepositories,
    run,
  });
}

describe("image publication", () => {
  test("pushes an image ECR lacks with crane and pins OpenTofu to the release digest", async () => {
    const path = await imageArchive();
    const { calls, run, scratch } = registry({ holds: false, pushes: digest });
    expect(await publish(run, path)).toEqual({ "model-gateway": `${uri}@${digest}` });
    expect(calls).toEqual([
      [
        "aws",
        "ecr",
        "--region",
        "us-east-2",
        "--output",
        "text",
        "--no-cli-pager",
        "describe-repositories",
        "--repository-names",
        "deployments-ai/platform/model-gateway",
        "--query",
        "repositories[0].repositoryUri",
      ],
      [
        "aws",
        "ecr",
        "put-lifecycle-policy",
        "--region",
        "us-east-2",
        "--repository-name",
        "deployments-ai/platform/model-gateway",
        "--lifecycle-policy-text",
        lifecyclePolicy,
        "--output",
        "text",
        "--no-cli-pager",
      ],
      [
        "aws",
        "ecr",
        "describe-images",
        "--region",
        "us-east-2",
        "--repository-name",
        "deployments-ai/platform/model-gateway",
        "--image-ids",
        `imageDigest=${digest}`,
        "--output",
        "text",
        "--no-cli-pager",
      ],
      ["aws", "ecr", "get-login-password", "--region", "us-east-2"],
      [
        "crane",
        "auth",
        "login",
        "123456789012.dkr.ecr.us-east-2.amazonaws.com",
        "--username",
        "AWS",
        "--password-stdin",
      ],
      ["tar", "-xf", path, "-C", "<scratch>/model-gateway"],
      ["crane", "push", "<scratch>/model-gateway", `${uri}:${sourceCommit}-abababababab`],
    ]);
    expect(scratch()).not.toBe("");
    expect(existsSync(scratch())).toBe(false);
  });

  test("reuses an image ECR already holds without logging in or pushing", async () => {
    const { calls, run } = registry({ holds: true, pushes: digest });
    expect(await publish(run, "/bundle/images/model-gateway.oci.tar")).toEqual({
      "model-gateway": `${uri}@${digest}`,
    });
    expect(calls.map((command) => command.slice(0, 3).join(" "))).toEqual([
      "aws ecr --region",
      "aws ecr put-lifecycle-policy",
      "aws ecr describe-images",
    ]);
  });

  test("fails when the pushed digest is not the release digest", async () => {
    const path = await imageArchive();
    const { run } = registry({ holds: false, pushes: `sha256:${"cd".repeat(32)}` });
    expect(publish(run, path)).rejects.toThrow(
      `Pushing the model-gateway image produced ${uri}@sha256:${"cd".repeat(32)}, not ${digest}.`,
    );
  });
});
