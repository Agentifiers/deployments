import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseBundle } from "../release-bundle.ts";
import { fetchRelease } from "./fetch.ts";
import { memoryRegistryStore } from "./memory-store.ts";
import {
  localSigner,
  publishFixture,
  rejectionMessage,
  useTemporaryDirectories,
} from "./registry.fixture.ts";
import { readObjectBytes } from "./store.ts";

const temporaryDirectory = useTemporaryDirectories();
const allImages = [
  "agent-worker",
  "bifrost",
  "durable-streams",
  "firecrawl",
  "model-gateway",
  "observability-hot-plane",
  "stream-gateway",
  "web-tools-proxy",
];
const imagesWithoutWebTools = [
  "agent-worker",
  "bifrost",
  "durable-streams",
  "model-gateway",
  "observability-hot-plane",
  "stream-gateway",
] as const;

async function signedRelease() {
  const store = memoryRegistryStore();
  const keys = temporaryDirectory();
  const { publicKeyPath, signer } = localSigner(keys);
  const record = await publishFixture({
    builtAt: "2026-10-09T03:51:43.000Z",
    bundle: temporaryDirectory(),
    images: allImages,
    signer,
    store,
  });
  return { keys, publicKeyPath, record, store };
}

describe("release fetch", () => {
  test("downloads the requested images, leaves the others out, and verifies it", async () => {
    const { publicKeyPath, record, store } = await signedRelease();
    const bundle = join(temporaryDirectory(), "bundle");

    const release = await fetchRelease({
      bundle,
      images: imagesWithoutWebTools,
      releaseManifestSha256: record.releaseManifestSha256,
      signingPublicKeyPath: publicKeyPath,
      store,
    });

    expect(release.manifestSha256).toBe(record.releaseManifestSha256);
    expect(Object.keys(release.images).toSorted()).toEqual([
      "agent-worker",
      "bifrost",
      "durable-streams",
      "model-gateway",
      "observability-hot-plane",
      "stream-gateway",
    ]);
    expect(release.absentImages).toEqual(["firecrawl", "web-tools-proxy"]);
    expect(readdirSync(join(bundle, "images")).toSorted()).toEqual([
      "agent-worker.oci.tar",
      "bifrost.oci.tar",
      "durable-streams.oci.tar",
      "model-gateway.oci.tar",
      "observability-hot-plane.oci.tar",
      "stream-gateway.oci.tar",
    ]);
    expect(existsSync(join(bundle, "release-record.json"))).toBe(true);
    expect(existsSync(join(bundle, "release-record.sig.json"))).toBe(true);

    const rerun = await fetchRelease({
      bundle,
      images: "all",
      releaseManifestSha256: record.releaseManifestSha256,
      signingPublicKeyPath: publicKeyPath,
      store,
    });
    expect(rerun.absentImages).toEqual([]);
  });

  test("fetches and verifies a version 3 release as one that ships the platform console", async () => {
    const store = memoryRegistryStore();
    const { publicKeyPath, signer } = localSigner(temporaryDirectory());
    const record = await publishFixture({
      builtAt: "2026-10-09T03:51:43.000Z",
      bundle: temporaryDirectory(),
      images: allImages,
      signer,
      store,
      version: 3,
    });
    const bundle = join(temporaryDirectory(), "bundle");
    const fetched = await fetchRelease({
      bundle,
      images: imagesWithoutWebTools,
      releaseManifestSha256: record.releaseManifestSha256,
      signingPublicKeyPath: publicKeyPath,
      store,
    });
    const verified = await verifyReleaseBundle(bundle, [], { signingPublicKeyPath: publicKeyPath });
    expect(JSON.parse(readFileSync(join(bundle, "release.json"), "utf8")).version).toBe(3);
    expect(
      [fetched, verified].map((release) => ({
        absentImages: release.absentImages,
        consoleBuild: release.consoleBuild,
        manifestSha256: release.manifestSha256,
      })),
    ).toEqual([
      {
        absentImages: ["firecrawl", "web-tools-proxy"],
        consoleBuild: "platform",
        manifestSha256: record.releaseManifestSha256,
      },
      {
        absentImages: ["firecrawl", "web-tools-proxy"],
        consoleBuild: "platform",
        manifestSha256: record.releaseManifestSha256,
      },
    ]);
  });

  test("refuses a release whose signature does not match before writing anything", async () => {
    const { record, store } = await signedRelease();
    const other = localSigner(temporaryDirectory(), "arn:aws:kms:us-east-2:123456789012:key/other");
    const bundle = join(temporaryDirectory(), "bundle");

    expect(
      await rejectionMessage(
        fetchRelease({
          bundle,
          images: "all",
          releaseManifestSha256: record.releaseManifestSha256,
          signingPublicKeyPath: other.publicKeyPath,
          store,
        }),
      ),
    ).toBe(
      `Release ${record.releaseManifestSha256} signature does not match ${other.publicKeyPath}.`,
    );
    expect(existsSync(bundle)).toBe(false);
  });

  test("refuses an unsigned release when a signing key is configured", async () => {
    const store = memoryRegistryStore();
    const record = await publishFixture({
      builtAt: "2026-10-09T03:51:43.000Z",
      bundle: temporaryDirectory(),
      store,
    });
    const { publicKeyPath } = localSigner(temporaryDirectory());
    expect(
      fetchRelease({
        bundle: temporaryDirectory(),
        images: "all",
        releaseManifestSha256: record.releaseManifestSha256,
        signingPublicKeyPath: publicKeyPath,
        store,
      }),
    ).rejects.toThrow(`Release ${record.releaseManifestSha256} is unsigned.`);
  });

  test("reports a release whose files expired as expired and writes nothing", async () => {
    const { publicKeyPath, record, store } = await signedRelease();
    store.runLifecycle();
    const bundle = join(temporaryDirectory(), "bundle");

    expect(
      await rejectionMessage(
        fetchRelease({
          bundle,
          images: "all",
          releaseManifestSha256: record.releaseManifestSha256,
          signingPublicKeyPath: publicKeyPath,
          store,
        }),
      ),
    ).toBe(
      `Release 2026.10.09-0123456 (${record.releaseManifestSha256}) has expired: the lifecycle removed 27 of its 27 files.`,
    );
    expect(existsSync(bundle)).toBe(false);
  });

  test("fails closed when a stored object differs from the record", async () => {
    const { record, store } = await signedRelease();
    const tampered = memoryRegistryStore();
    const prefix = `releases/${record.releaseManifestSha256}/`;
    for (const file of [...Object.keys(record.files), "release-record.json"]) {
      const original = await readObjectBytes(store, `${prefix}${file}`);
      const bytes =
        file === "platform-api.zip"
          ? new TextEncoder().encode("tampered")
          : (original ?? new Uint8Array());
      await tampered.putObject({
        body: { bytes, kind: "bytes" },
        key: `${prefix}${file}`,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        tags: {},
      });
    }

    expect(
      fetchRelease({
        bundle: temporaryDirectory(),
        images: "all",
        releaseManifestSha256: record.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store: tampered,
      }),
    ).rejects.toThrow(`Checksum mismatch for ${prefix}platform-api.zip.`);
  });

  test("lets deploy verification reject a fetched bundle whose record was swapped", async () => {
    const { publicKeyPath, record, store } = await signedRelease();
    const bundle = temporaryDirectory();
    await fetchRelease({
      bundle,
      images: "all",
      releaseManifestSha256: record.releaseManifestSha256,
      signingPublicKeyPath: publicKeyPath,
      store,
    });
    const swapped = readFileSync(join(bundle, "release-record.json"), "utf8").replace(
      '"ciRunId": null',
      '"ciRunId": 1',
    );
    writeFileSync(join(bundle, "release-record.json"), swapped);

    expect(
      verifyReleaseBundle(bundle, ["durable-streams"], { signingPublicKeyPath: publicKeyPath }),
    ).rejects.toThrow(`Release record signature does not match ${publicKeyPath}.`);
    expect(verifyReleaseBundle(bundle, ["durable-streams"])).resolves.toMatchObject({
      manifestSha256: record.releaseManifestSha256,
    });
  });

  test("refuses to mix two releases in one directory", async () => {
    const { publicKeyPath, record, store } = await signedRelease();
    const other = await publishFixture({
      builtAt: "2026-10-10T00:00:00.000Z",
      bundle: temporaryDirectory(),
      store,
    });
    const bundle = temporaryDirectory();
    await fetchRelease({
      bundle,
      images: "all",
      releaseManifestSha256: record.releaseManifestSha256,
      signingPublicKeyPath: publicKeyPath,
      store,
    });
    expect(
      fetchRelease({
        bundle,
        images: "all",
        releaseManifestSha256: other.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
      }),
    ).rejects.toThrow("holds a different release; fetch into an empty directory.");
  });
});
