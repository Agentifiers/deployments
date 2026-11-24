import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export async function clientPackageFingerprint(
  packageDirectory: string,
  manifest: Readonly<Record<string, unknown>>,
): Promise<string> {
  const { deploymentsArtifactSha256: _storedFingerprint, ...fingerprintedManifest } = manifest;
  const artifactHash = createHash("sha256").update(JSON.stringify(fingerprintedManifest));
  const artifactEntries = await readdir(packageDirectory, { recursive: true, withFileTypes: true });
  for (const entry of artifactEntries
    .filter((candidate) => candidate.isFile() && candidate.name !== "package.json")
    .map((candidate) => resolve(candidate.parentPath, candidate.name))
    .sort()) {
    artifactHash
      .update(relative(packageDirectory, entry))
      .update("\0")
      .update(await readFile(entry));
  }
  return artifactHash.digest("hex");
}
