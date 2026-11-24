import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, CommandFailure, type Environment, log, mask } from "./process.ts";
import type { PlatformImageName } from "./profiles.ts";
import { ecrImageTag, type VerifiedRelease } from "./release-bundle.ts";

function missing(error: unknown, code: string) {
  return error instanceof CommandFailure && error.stderr.includes(code);
}

async function repositoryUri(input: {
  readonly region: string;
  readonly repository: string;
  readonly run: CommandRunner;
}) {
  const aws = ["aws", "ecr", "--region", input.region, "--output", "text", "--no-cli-pager"];
  try {
    return (
      await input.run([
        ...aws,
        "describe-repositories",
        "--repository-names",
        input.repository,
        "--query",
        "repositories[0].repositoryUri",
      ])
    ).trim();
  } catch (error) {
    if (!missing(error, "RepositoryNotFoundException")) throw error;
  }
  log(`creating ECR repository ${input.repository}`);
  return (
    await input.run([
      ...aws,
      "create-repository",
      "--repository-name",
      input.repository,
      "--image-scanning-configuration",
      "scanOnPush=true",
      "--image-tag-mutability",
      "IMMUTABLE",
      "--encryption-configuration",
      "encryptionType=AES256",
      "--query",
      "repository.repositoryUri",
    ])
  ).trim();
}

/**
 * Keeps the newest 30 release images per repository. Untagged entries are the
 * platform and attestation manifests of release indexes, which ECR never
 * expires while a tagged index references them, so the second rule only
 * removes manifests orphaned by an expired index. ECR does not know which
 * digests a service runs, so 30 must cover every digest a deployment or
 * rollback can still pull.
 */
export const lifecyclePolicy = JSON.stringify({
  rules: [
    {
      rulePriority: 1,
      description: "Keep the newest 30 release images",
      selection: {
        tagStatus: "tagged",
        tagPatternList: ["*"],
        countType: "imageCountMoreThan",
        countNumber: 30,
      },
      action: { type: "expire" },
    },
    {
      rulePriority: 2,
      description: "Expire manifests no release index references",
      selection: {
        tagStatus: "untagged",
        countType: "sinceImagePushed",
        countUnit: "days",
        countNumber: 1,
      },
      action: { type: "expire" },
    },
  ],
});

async function hasImage(run: CommandRunner, region: string, repository: string, digest: string) {
  try {
    await run([
      "aws",
      "ecr",
      "describe-images",
      "--region",
      region,
      "--repository-name",
      repository,
      "--image-ids",
      `imageDigest=${digest}`,
      "--output",
      "text",
      "--no-cli-pager",
    ]);
    return true;
  } catch (error) {
    if (missing(error, "ImageNotFoundException")) return false;
    throw error;
  }
}

/**
 * Copies each requested release image into the target account's ECR by its
 * OCI index digest and returns digest-pinned image URIs. `crane` pushes the
 * index with its attestation manifests unchanged, so the pushed digest is the
 * release's digest and no Docker daemon is involved. An image ECR already
 * holds is reused without pushing.
 */
export async function publishImages(input: {
  readonly environment: Environment;
  readonly names: readonly PlatformImageName[];
  readonly region: string;
  readonly release: Pick<VerifiedRelease, "images" | "sourceCommit">;
  readonly repositories: Readonly<Record<PlatformImageName, string>>;
  readonly run: CommandRunner;
}) {
  const { region, release, run } = input;
  const scratch = await mkdtemp(
    join(input.environment.RUNNER_TEMP || tmpdir(), "platform-images-"),
  );
  // A private registry credential file keeps the ECR token out of the caller's Docker config.
  const crane = { env: { ...input.environment, DOCKER_CONFIG: join(scratch, "docker") } };
  const loggedIn = new Set<string>();
  const uris: Partial<Record<PlatformImageName, string>> = {};
  try {
    for (const name of input.names) {
      const image = release.images[name];
      if (!image) throw new Error(`Release bundle is missing the ${name} image archive.`);
      const repository = input.repositories[name];
      const uri = await repositoryUri({ region, repository, run });
      await run([
        "aws",
        "ecr",
        "put-lifecycle-policy",
        "--region",
        region,
        "--repository-name",
        repository,
        "--lifecycle-policy-text",
        lifecyclePolicy,
        "--output",
        "text",
        "--no-cli-pager",
      ]);
      if (await hasImage(run, region, repository, image.digest)) {
        log(`reusing ${name} image ${uri}@${image.digest}`);
      } else {
        const registry = uri.split("/")[0]!;
        if (!loggedIn.has(registry)) {
          const password = await run(["aws", "ecr", "get-login-password", "--region", region]);
          mask(password.trim());
          await run(["crane", "auth", "login", registry, "--username", "AWS", "--password-stdin"], {
            ...crane,
            input: password,
          });
          loggedIn.add(registry);
        }
        const layout = join(scratch, name);
        await mkdir(layout);
        await run(["tar", "-xf", image.path, "-C", layout]);
        const reference = `${uri}:${ecrImageTag(release.sourceCommit, image.digest)}`;
        log(`pushing ${name} image ${reference}`);
        const pushed = (await run(["crane", "push", layout, reference], crane)).trim();
        await rm(layout, { force: true, recursive: true });
        if (!pushed.endsWith(`@${image.digest}`)) {
          throw new Error(`Pushing the ${name} image produced ${pushed}, not ${image.digest}.`);
        }
      }
      uris[name] = `${uri}@${image.digest}`;
    }
    return uris;
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}
