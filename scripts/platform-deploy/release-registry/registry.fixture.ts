import { afterEach } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureBundle } from "../release-bundle.fixture.ts";
import { publishRelease } from "./publish.ts";
import type { CompatibilityReason } from "./record.ts";
import type { ReleaseSigner } from "./signing.ts";
import type { RegistryStore } from "./store.ts";

export function useTemporaryDirectories() {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  return () => {
    const directory = mkdtempSync(join(tmpdir(), "release-registry-"));
    directories.push(directory);
    return directory;
  };
}

export async function rejectionMessage(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the promise to reject.");
}

export function localSigner(
  directory: string,
  keyId = "arn:aws:kms:us-east-2:123456789012:key/test",
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPath = join(directory, `${keyId.split("/").at(-1) ?? "key"}.pem`);
  writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
  const signer: ReleaseSigner = {
    publicKey: async () => publicKey,
    sign: async (message) => ({ keyId, signature: sign("sha256", message, privateKey) }),
  };
  return { publicKeyPath, signer };
}

export async function publishFixture(input: {
  readonly builtAt: string;
  readonly bundle: string;
  readonly deployerImage?: string;
  readonly images?: readonly string[];
  readonly reasons?: readonly CompatibilityReason[];
  readonly signer?: ReleaseSigner | undefined;
  readonly sourceCommit?: string;
  readonly store: RegistryStore;
  readonly version?: 3 | 4;
}) {
  writeFixtureBundle(input.bundle, {
    builtAt: input.builtAt,
    images: input.images ?? ["durable-streams", "firecrawl", "observability-hot-plane"],
    imageSalt: input.builtAt,
    ...(input.sourceCommit === undefined ? {} : { sourceCommit: input.sourceCommit }),
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  return await publishRelease({
    bundle: input.bundle,
    ciRunId: null,
    compatibilityReasons: async () => input.reasons ?? [],
    deployerImage: input.deployerImage ?? null,
    now: () => new Date("2026-10-09T04:02:10.000Z"),
    signer: input.signer,
    signingPublicKeyPath: undefined,
    store: input.store,
  });
}
