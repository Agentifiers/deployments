import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  HookState,
  LambdaMicrovmsClient,
  ListManagedMicrovmImageVersionsCommand,
  ListMicrovmImagesCommand,
  type ManagedMicrovmImageVersion,
  type MicrovmImageSummary,
} from "@aws-sdk/client-lambda-microvms";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const MICROVM_CONTEXT = "apps/sandbox-microvm";
const MICROVM_ARCHITECTURE = "ARM_64";
const MICROVM_HOOK_PORT = 8080;
const MICROVM_HOOK_TIMEOUT_SECONDS = 60;
/** The validate hook launches Chromium once in a MicroVM whose image files are still unread. */
const MICROVM_VALIDATE_TIMEOUT_SECONDS = 600;
/** The desktop variant appends its layer to the sandbox Dockerfile; it is not a standalone image. */
const DESKTOP_LAYER = "desktop/layer.Dockerfile";

export type MicrovmImageVariant = "sandbox" | "desktop";

const MICROVM_VARIANTS = {
  sandbox: {
    component: "agent-sandbox-microvm",
    description: "Deployments.ai content-addressed agent sandbox",
    minimumMemoryInMiB: 2048,
    namePrefix: "sandbox",
    vcpu: 1,
  },
  // Firefox, Xvfb, and the accessibility bus need more than the 2 GiB sandbox baseline.
  desktop: {
    component: "agent-sandbox-desktop-microvm",
    description: "Deployments.ai content-addressed agent sandbox with a desktop (prototype)",
    minimumMemoryInMiB: 4096,
    namePrefix: "sandbox-desktop",
    vcpu: 2,
  },
} as const satisfies Record<
  MicrovmImageVariant,
  {
    component: string;
    description: string;
    minimumMemoryInMiB: number;
    namePrefix: string;
    vcpu: number;
  }
>;

/** The memory and vCPU each MicroVM of a variant runs with, a supported Lambda MicroVM pair. */
export function microvmImageCapacity(variant: MicrovmImageVariant) {
  const { minimumMemoryInMiB, vcpu } = MICROVM_VARIANTS[variant];
  return { memoryMiB: minimumMemoryInMiB, vcpu };
}
const MICROVM_IMAGE_VERSION = "1.0";
export const MICROVM_LOG_GROUP = "/aws/lambda-microvms/deployments-ai-sandbox";
const MICROVM_POLL_INTERVAL_MS = 15_000;
const MICROVM_TIMEOUT_MS = 15 * 60_000;
const AWS_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

type MicrovmBuildConfig = {
  readonly architecture: string;
  readonly baseImageArn: string;
  readonly baseImageVersion: string;
  readonly minimumMemoryInMiB: number;
};

type MicrovmImage = {
  readonly imageArn: string;
  readonly imageVersion: string;
};

type RunOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

async function run(command: readonly string[], options: RunOptions = {}) {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolveExit(exitCode ?? 1));
  });
  return {
    code,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function runChecked(command: readonly string[], options?: RunOptions) {
  const result = await run(command, options);
  if (result.code !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function assertContentHash(hash: string) {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Expected a SHA-256 MicroVM content hash.");
}

export function microvmContentHashFromEntries(
  entries: readonly (readonly [string, Uint8Array])[],
  config: MicrovmBuildConfig,
) {
  const hasher = createHash("sha256");
  hasher.update(
    `lambda-microvm-v4\0${config.baseImageArn}\0${config.baseImageVersion}\0${config.architecture}\0${config.minimumMemoryInMiB}\0hooks:${MICROVM_HOOK_PORT}:${MICROVM_HOOK_TIMEOUT_SECONDS}:${MICROVM_VALIDATE_TIMEOUT_SECONDS}\0`,
  );
  for (const [name, content] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
    hasher.update(`${name}\0`);
    hasher.update(content);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

export function microvmImageName(hash: string, variant: MicrovmImageVariant = "sandbox") {
  assertContentHash(hash);
  return `deployments-ai-${MICROVM_VARIANTS[variant].namePrefix}-${hash.slice(0, 24)}`;
}

export function microvmArtifactKey(hash: string) {
  assertContentHash(hash);
  return `sandbox-microvm/${hash}.zip`;
}

export function microvmImageArn(accountId: string, region: string, imageName: string) {
  return `arn:aws:lambda:${region}:${accountId}:microvm-image:${imageName}`;
}

export function plannedMicrovmImage(
  accountId: string,
  region: string,
  hash: string,
  variant: MicrovmImageVariant = "sandbox",
): MicrovmImage {
  return {
    imageArn: microvmImageArn(accountId, region, microvmImageName(hash, variant)),
    imageVersion: MICROVM_IMAGE_VERSION,
  };
}

async function microvmInputFiles(root: string) {
  const output = await runChecked(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", MICROVM_CONTEXT],
    { cwd: root },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.includes("/__pycache__/") && !file.endsWith(".pyc"))
    .filter((file) => existsSync(resolve(root, file)))
    .toSorted();
}

/**
 * Selects a variant's build context. The sandbox leaves out `desktop/`. The desktop variant keeps
 * every file and replaces `Dockerfile` with the sandbox Dockerfile followed by the desktop layer, so
 * Lambda builds both from one Dockerfile at the archive root.
 */
export function microvmVariantEntries(
  entries: readonly (readonly [string, Uint8Array])[],
  variant: MicrovmImageVariant,
): (readonly [string, Uint8Array])[] {
  if (variant === "sandbox") return entries.filter(([name]) => !name.startsWith("desktop/"));
  const content = (name: string) => {
    const entry = entries.find(([entryName]) => entryName === name);
    if (!entry) throw new Error(`The desktop image variant requires ${MICROVM_CONTEXT}/${name}.`);
    return new TextDecoder().decode(entry[1]);
  };
  const dockerfile = `${content("Dockerfile").trimEnd()}\n\n${content(DESKTOP_LAYER)}`;
  return entries.map(([name, bytes]) =>
    name === "Dockerfile" ? ([name, new TextEncoder().encode(dockerfile)] as const) : [name, bytes],
  );
}

async function microvmBuildInputs(
  root: string,
  baseImageArn: string,
  baseImageVersion: string,
  variant: MicrovmImageVariant,
) {
  const files = await microvmInputFiles(root);
  if (files.length === 0) throw new Error(`No build inputs found under ${MICROVM_CONTEXT}.`);
  const contextDirectory = resolve(root, MICROVM_CONTEXT);
  const archiveEntries = microvmVariantEntries(
    await Promise.all(
      files.map(async (file) => {
        const absolute = resolve(root, file);
        return [relative(contextDirectory, absolute), await readFile(absolute)] as const;
      }),
    ),
    variant,
  );
  const toolingEntry = [
    "@tooling/scripts/lambda-microvm-image.ts",
    await readFile(resolve(root, "scripts/lambda-microvm-image.ts")),
  ] as const;
  const hash = microvmContentHashFromEntries([...archiveEntries, toolingEntry], {
    architecture: MICROVM_ARCHITECTURE,
    baseImageArn,
    baseImageVersion,
    minimumMemoryInMiB: MICROVM_VARIANTS[variant].minimumMemoryInMiB,
  });
  return { archiveEntries, hash };
}

async function awsAccountId(env: NodeJS.ProcessEnv) {
  return (
    await runChecked(
      ["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"],
      { env },
    )
  ).trim();
}

async function withAwsEnvironment<T>(env: NodeJS.ProcessEnv, task: () => Promise<T>) {
  const previous = new Map<string, string | undefined>();
  for (const key of AWS_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await task();
  } finally {
    for (const key of AWS_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function findMicrovmImage(client: LambdaMicrovmsClient, name: string) {
  let nextToken: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- Pagination must preserve the service cursor order.
    const response = await client.send(
      new ListMicrovmImagesCommand({
        maxResults: 50,
        nameFilter: name,
        nextToken,
      }),
    );
    const match = response.items?.find((item) => item.name === name);
    if (match) return match;
    nextToken = response.nextToken;
  } while (nextToken);
  return undefined;
}

export function latestManagedMicrovmImageVersion(
  imageArn: string,
  versions: readonly ManagedMicrovmImageVersion[],
) {
  const latest = versions
    .filter(
      (version) =>
        version.imageArn === imageArn &&
        typeof version.imageVersion === "string" &&
        version.imageVersion.length > 0 &&
        version.createdAt instanceof Date &&
        Number.isFinite(version.createdAt.getTime()),
    )
    .toSorted((left, right) => right.createdAt!.getTime() - left.createdAt!.getTime())[0];
  if (!latest?.imageVersion) {
    throw new Error(`AWS-managed Lambda MicroVM base image ${imageArn} has no available version.`);
  }
  return latest.imageVersion;
}

async function managedMicrovmBaseImageVersion(client: LambdaMicrovmsClient, imageArn: string) {
  const versions: ManagedMicrovmImageVersion[] = [];
  let nextToken: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- Pagination must preserve the service cursor order.
    const response = await client.send(
      new ListManagedMicrovmImageVersionsCommand({
        imageIdentifier: imageArn,
        maxResults: 50,
        nextToken,
      }),
    );
    versions.push(...(response.items ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return latestManagedMicrovmImageVersion(imageArn, versions);
}

function terminalImageFailure(image: MicrovmImageSummary) {
  return image.state === "CREATE_FAILED" || image.state === "UPDATE_FAILED";
}

async function waitForMicrovmImage(
  client: LambdaMicrovmsClient,
  imageIdentifier: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "UNKNOWN";
  let lastReason = "";
  while (Date.now() <= deadline) {
    // eslint-disable-next-line no-await-in-loop -- Image readiness is an ordered service-state poll.
    const image = await client.send(new GetMicrovmImageCommand({ imageIdentifier }));
    lastState = image.state ?? "UNKNOWN";
    if (
      (image.state === "CREATED" || image.state === "UPDATED") &&
      image.imageArn &&
      image.latestActiveImageVersion
    ) {
      return {
        imageArn: image.imageArn,
        imageVersion: image.latestActiveImageVersion,
      };
    }
    if (image.state === "CREATE_FAILED" || image.state === "UPDATE_FAILED") {
      if (image.latestFailedImageVersion) {
        // eslint-disable-next-line no-await-in-loop -- Failure detail belongs to the failed version discovered by this poll.
        const failedVersion = await client.send(
          new GetMicrovmImageVersionCommand({
            imageIdentifier,
            imageVersion: image.latestFailedImageVersion,
          }),
        );
        lastReason = failedVersion.stateReason ?? "";
      }
      throw new Error(`Lambda MicroVM image ${imageIdentifier} failed: ${lastReason}`);
    }
    // eslint-disable-next-line no-await-in-loop -- Polling intentionally waits between service reads.
    await Bun.sleep(MICROVM_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for Lambda MicroVM image ${imageIdentifier}; last state ${lastState}${lastReason ? `: ${lastReason}` : ""}`,
  );
}

async function verifyMicrovmVersion(
  client: LambdaMicrovmsClient,
  image: MicrovmImage,
): Promise<MicrovmImage> {
  const version = await client.send(
    new GetMicrovmImageVersionCommand({
      imageIdentifier: image.imageArn,
      imageVersion: image.imageVersion,
    }),
  );
  if (version.state !== "SUCCESSFUL" || version.status !== "ACTIVE") {
    throw new Error(
      `Lambda MicroVM image ${image.imageArn}@${image.imageVersion} is ${version.state ?? "UNKNOWN"}/${version.status ?? "UNKNOWN"}${version.stateReason ? `: ${version.stateReason}` : ""}`,
    );
  }
  return image;
}

const WRITE_ARCHIVE_SCRIPT = [
  "import sys, zipfile",
  "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:",
  "    for name in sys.argv[2:]:",
  "        archive.write(name, arcname=name)",
].join("\n");

/** Zips exactly `names` (relative to `contextDirectory`) under their relative paths. */
export async function writeMicrovmArchive(
  contextDirectory: string,
  archive: string,
  names: readonly string[],
) {
  await runChecked(["python3", "-c", WRITE_ARCHIVE_SCRIPT, archive, ...names], {
    cwd: contextDirectory,
  });
}

async function uploadArtifact(options: {
  readonly archiveEntries: readonly (readonly [string, Uint8Array])[];
  readonly bucket: string;
  readonly env: NodeJS.ProcessEnv;
  readonly key: string;
  readonly root: string;
}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "deployments-ai-microvm-"));
  const archive = join(temporaryDirectory, "sandbox-microvm.zip");
  const stagingDirectory = join(temporaryDirectory, "context");
  try {
    await Promise.all(
      options.archiveEntries.map(async ([name, bytes]) => {
        const target = resolve(stagingDirectory, name);
        if (relative(stagingDirectory, target).startsWith("..")) {
          throw new Error(`MicroVM archive entry escapes the build context: ${name}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }),
    );
    await writeMicrovmArchive(
      stagingDirectory,
      archive,
      options.archiveEntries.map(([name]) => name),
    );
    await runChecked(
      ["aws", "s3", "cp", archive, `s3://${options.bucket}/${options.key}`, "--only-show-errors"],
      { env: options.env },
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function resolveLambdaMicrovmImage(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly publish: boolean;
  readonly region?: string;
  readonly root?: string;
  readonly timeoutMs?: number;
  readonly variant?: MicrovmImageVariant;
}): Promise<MicrovmImage> {
  const root = options.root ?? process.cwd();
  const variant = options.variant ?? "sandbox";
  const region = (
    options.region ??
    options.env.AWS_REGION ??
    options.env.AWS_DEFAULT_REGION ??
    ""
  ).trim();
  if (!region) {
    throw new Error(
      "Lambda MicroVM image publishing requires --region, AWS_REGION, or AWS_DEFAULT_REGION.",
    );
  }
  const baseImageArn = `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
  const baseImageVersion = await withAwsEnvironment(options.env, async () => {
    const client = new LambdaMicrovmsClient({ region });
    return await managedMicrovmBaseImageVersion(client, baseImageArn);
  });
  const [{ archiveEntries, hash }, accountId] = await Promise.all([
    microvmBuildInputs(root, baseImageArn, baseImageVersion, variant),
    awsAccountId(options.env),
  ]);
  const planned = plannedMicrovmImage(accountId, region, hash, variant);
  if (!options.publish) return planned;

  const name = microvmImageName(hash, variant);
  const artifactBucket = `microvm-artifacts-${accountId}`;
  const artifactKey = microvmArtifactKey(hash);
  const buildRoleArn = `arn:aws:iam::${accountId}:role/microvm-build`;

  return await withAwsEnvironment(options.env, async () => {
    const client = new LambdaMicrovmsClient({ region });
    const existing = await findMicrovmImage(client, name);
    if (existing) {
      if (terminalImageFailure(existing)) {
        throw new Error(`Existing Lambda MicroVM image ${name} is ${existing.state}.`);
      }
      if (
        (existing.state === "CREATED" || existing.state === "UPDATED") &&
        existing.imageArn &&
        existing.latestActiveImageVersion
      ) {
        return await verifyMicrovmVersion(client, {
          imageArn: existing.imageArn,
          imageVersion: existing.latestActiveImageVersion,
        });
      }
      return await verifyMicrovmVersion(
        client,
        await waitForMicrovmImage(
          client,
          existing.imageArn ?? planned.imageArn,
          options.timeoutMs ?? MICROVM_TIMEOUT_MS,
        ),
      );
    }

    process.stderr.write(`[microvm] uploading ${artifactKey}\n`);
    await uploadArtifact({
      archiveEntries,
      bucket: artifactBucket,
      env: options.env,
      key: artifactKey,
      root,
    });
    process.stderr.write(`[microvm] creating ${name}\n`);
    const created = await client.send(
      new CreateMicrovmImageCommand({
        baseImageArn,
        baseImageVersion,
        buildRoleArn,
        clientToken: hash,
        codeArtifact: { uri: `s3://${artifactBucket}/${artifactKey}` },
        cpuConfigurations: [{ architecture: MICROVM_ARCHITECTURE }],
        description: MICROVM_VARIANTS[variant].description,
        hooks: {
          port: MICROVM_HOOK_PORT,
          microvmHooks: {
            run: HookState.ENABLED,
            runTimeoutInSeconds: MICROVM_HOOK_TIMEOUT_SECONDS,
            resume: HookState.ENABLED,
            resumeTimeoutInSeconds: MICROVM_HOOK_TIMEOUT_SECONDS,
            suspend: HookState.ENABLED,
            suspendTimeoutInSeconds: MICROVM_HOOK_TIMEOUT_SECONDS,
            terminate: HookState.ENABLED,
            terminateTimeoutInSeconds: MICROVM_HOOK_TIMEOUT_SECONDS,
          },
          microvmImageHooks: {
            ready: HookState.ENABLED,
            readyTimeoutInSeconds: MICROVM_HOOK_TIMEOUT_SECONDS,
            validate: HookState.ENABLED,
            validateTimeoutInSeconds: MICROVM_VALIDATE_TIMEOUT_SECONDS,
          },
        },
        logging: { cloudWatch: { logGroup: MICROVM_LOG_GROUP } },
        name,
        resources: [{ minimumMemoryInMiB: MICROVM_VARIANTS[variant].minimumMemoryInMiB }],
        tags: {
          Application: "deployments-ai",
          Component: MICROVM_VARIANTS[variant].component,
          ContentHash: hash,
          ManagedBy: "terraform-wrapper",
        },
      }),
    );
    return await verifyMicrovmVersion(
      client,
      await waitForMicrovmImage(
        client,
        created.imageArn ?? planned.imageArn,
        options.timeoutMs ?? MICROVM_TIMEOUT_MS,
      ),
    );
  });
}

if (import.meta.main) {
  const publish = process.argv.includes("--publish");
  const regionOptionIndex = process.argv.indexOf("--region");
  const region = regionOptionIndex === -1 ? undefined : process.argv[regionOptionIndex + 1];
  const variantOptionIndex = process.argv.indexOf("--variant");
  const variant = variantOptionIndex === -1 ? "sandbox" : process.argv[variantOptionIndex + 1];
  if (regionOptionIndex !== -1 && (!region || region.startsWith("--"))) {
    process.stderr.write("--region requires an AWS region value.\n");
    process.exitCode = 1;
  } else if (variant !== "sandbox" && variant !== "desktop") {
    process.stderr.write("--variant must be sandbox or desktop.\n");
    process.exitCode = 1;
  } else {
    resolveLambdaMicrovmImage({
      env: process.env,
      publish,
      variant,
      ...(region ? { region } : {}),
    })
      .then((image) => process.stdout.write(`${JSON.stringify(image)}\n`))
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
