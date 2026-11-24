import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { publishedDistTags } from "./client-package-dist-tags.ts";
import { clientPackageFingerprint } from "./client-package-fingerprint.ts";
import { clientPackageRegistry as registry } from "./client-package-metadata.ts";

const root = resolve(import.meta.dir, "..");
const tag = process.argv[2] ?? "next";
if (tag !== "next" && tag !== "latest") {
  throw new Error(`Unsupported package dist-tag: ${tag}`);
}

const packageDirectories = [
  resolve(root, "packages/sdk/dist/package"),
  resolve(root, "packages/cli/dist/package"),
];
const manifests = await Promise.all(
  packageDirectories.map(async (directory) => ({
    directory,
    manifest: JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
      deploymentsArtifactSha256: string;
      name: string;
      version: string;
    },
  })),
);
const versions = new Set(manifests.map(({ manifest }) => manifest.version));
if (versions.size !== 1) throw new Error("SDK and CLI staged package versions must match.");
const version = manifests[0]!.manifest.version;
const stagingTag = `staged-${version.replace(/[^A-Za-z0-9-]/gu, "-")}`;
if (tag === "latest" && version.includes("-")) {
  throw new Error(`Refusing to publish prerelease version ${version} under latest.`);
}

async function capture(command: readonly string[], cwd = root) {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

// Trusted publishing authenticates dist-tag changes from npm 11.21.0 on.
const npmVersion = (await capture(["npm", "--version"])).stdout.trim();
const [npmMajor = 0, npmMinor = 0] = npmVersion.split(".").map(Number);
if (npmMajor < 11 || (npmMajor === 11 && npmMinor < 21)) {
  throw new Error(`Publishing needs npm 11.21.0 or later; found ${npmVersion || "no npm"}.`);
}

async function publishedArtifactSha256(name: string, packageVersion: string) {
  const result = await capture([
    "npm",
    "view",
    `${name}@${packageVersion}`,
    "deploymentsArtifactSha256",
    "--json",
    "--registry",
    registry,
  ]);
  if (result.exitCode === 0) {
    if (!result.stdout.trim()) {
      throw new Error(
        `Registry metadata for ${name}@${packageVersion} has no artifact fingerprint.`,
      );
    }
    const artifactSha256 = JSON.parse(result.stdout) as unknown;
    if (typeof artifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifactSha256)) {
      throw new Error(
        `Registry metadata for ${name}@${packageVersion} has an invalid fingerprint.`,
      );
    }
    return artifactSha256;
  }
  if (/\bE404\b|404 Not Found/u.test(result.stderr)) return undefined;
  throw new Error(`Checking ${name}@${packageVersion} failed: ${result.stderr.trim()}`);
}

async function applyDistTag(name: string, packageVersion: string, distTag: string) {
  const child = Bun.spawn(
    ["npm", "dist-tag", "add", `${name}@${packageVersion}`, distTag, "--registry", registry],
    { cwd: root, stderr: "inherit", stdout: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Tagging ${name}@${packageVersion} as ${distTag} exited with ${exitCode}`);
  }
}

async function removeDistTag(name: string, distTag: string) {
  const child = Bun.spawn(["npm", "dist-tag", "rm", name, distTag, "--registry", registry], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Removing ${name}'s ${distTag} tag exited with ${exitCode}`);
}

for (const { directory, manifest } of manifests) {
  if (!/^[a-f0-9]{64}$/u.test(manifest.deploymentsArtifactSha256)) {
    throw new Error(`Staged ${manifest.name} package has no valid artifact fingerprint.`);
  }
  const stagedSha256 = await clientPackageFingerprint(directory, manifest);
  if (stagedSha256 !== manifest.deploymentsArtifactSha256) {
    throw new Error(`Staged ${manifest.name} package does not match its artifact fingerprint.`);
  }
  const publishedSha256 = await publishedArtifactSha256(manifest.name, manifest.version);
  if (publishedSha256 !== undefined) {
    if (publishedSha256 !== stagedSha256) {
      throw new Error(
        `Refusing to skip ${manifest.name}@${manifest.version}: the published artifact does not match the staged package.`,
      );
    }
    console.log(
      `Skipping ${manifest.name}@${manifest.version}; the matching artifact is published.`,
    );
    continue;
  }
  const publish = Bun.spawn(
    [
      "npm",
      "publish",
      directory,
      "--tag",
      stagingTag,
      "--registry",
      registry,
      "--provenance",
      "--access",
      "public",
    ],
    { cwd: root, stderr: "inherit", stdout: "inherit" },
  );
  const exitCode = await publish.exited;
  if (exitCode !== 0) throw new Error(`Publishing ${manifest.name} exited with ${exitCode}`);
}

const previousTags = new Map<string, string | undefined>();
for (const { manifest } of manifests) {
  previousTags.set(
    manifest.name,
    (
      await publishedDistTags({
        capture,
        name: manifest.name,
        packageVersion: manifest.version,
        registry,
      })
    )[tag],
  );
}
const updatedTags: string[] = [];
try {
  for (const { manifest } of manifests) {
    await applyDistTag(manifest.name, manifest.version, tag);
    updatedTags.push(manifest.name);
  }
} catch (cause) {
  for (const name of updatedTags.reverse()) {
    const previousVersion = previousTags.get(name);
    if (previousVersion) await applyDistTag(name, previousVersion, tag);
    else await removeDistTag(name, tag);
  }
  throw cause;
}
for (const { manifest } of manifests) {
  const tags = await publishedDistTags({
    capture,
    name: manifest.name,
    packageVersion: manifest.version,
    registry,
  });
  if (tags[stagingTag] === manifest.version) await removeDistTag(manifest.name, stagingTag);
}

console.log(`Published SDK and CLI ${version} under ${tag}.`);
