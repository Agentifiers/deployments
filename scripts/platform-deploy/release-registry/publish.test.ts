import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFixtureBundle } from "../release-bundle.fixture.ts";
import { memoryRegistryStore } from "./memory-store.ts";
import { type PublishInput, publishRelease } from "./publish.ts";
import { decodeReleaseRecord, decodeReleaseSignature, encodeReleaseRecord } from "./record.ts";
import {
  localSigner,
  publishFixture,
  rejectionMessage,
  useTemporaryDirectories,
} from "./registry.fixture.ts";
import { type ReleaseSigner, verifyReleaseSignature } from "./signing.ts";
import { readObjectBytes, type RegistryStore } from "./store.ts";

const temporaryDirectory = useTemporaryDirectories();
const deployer = `123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/deployer@sha256:${"cd".repeat(32)}`;
const builtAt = "2026-10-09T03:51:43.000Z";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digestOf = (bundle: string) => sha256(readFileSync(join(bundle, "release.json")));

function publish(store: RegistryStore, bundle: string, overrides: Partial<PublishInput> = {}) {
  return publishRelease({
    bundle,
    ciRunId: null,
    compatibilityReasons: async () => [],
    deployerImage: null,
    now: () => new Date("2026-10-09T04:02:10.000Z"),
    signer: undefined,
    signingPublicKeyPath: undefined,
    store,
    ...overrides,
  });
}

async function predecessorChoice(
  configure: (key: {
    readonly publicKeyPath: string;
    readonly signer: ReleaseSigner;
  }) => Partial<PublishInput>,
) {
  const store = memoryRegistryStore();
  const key = localSigner(temporaryDirectory());
  const stranger = localSigner(
    temporaryDirectory(),
    "arn:aws:kms:us-east-2:123456789012:key/stranger",
  );
  const earlier = (day: string, sourceCommit: string, signer: ReleaseSigner | undefined) =>
    publishFixture({
      builtAt: `2026-10-0${day}T00:00:00.000Z`,
      bundle: temporaryDirectory(),
      signer,
      sourceCommit,
      store,
    });
  const signed = await earlier("1", "1".repeat(40), key.signer);
  await earlier("5", "2".repeat(40), undefined);
  const misSigned = await earlier("6", "4".repeat(40), stranger.signer);
  const compared: string[][] = [];
  const record = await publish(
    store,
    writeFixtureBundle(temporaryDirectory(), { builtAt, sourceCommit: "3".repeat(40) }),
    {
      compatibilityReasons: async (from, to) => {
        compared.push([from, to]);
        return [];
      },
      ...configure(key),
    },
  );
  return { compared, comparedWith: record.compatibility.comparedWith, misSigned, signed };
}

describe("release publish", () => {
  test("uploads every bundle file tagged to expire, then the record and its signature tagged to stay", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt, images: ["firecrawl"] });
    const { signer } = localSigner(temporaryDirectory());
    const digest = digestOf(bundle);

    const record = await publish(store, bundle, {
      ciRunId: 37877507979,
      deployerImage: deployer,
      signer,
    });

    expect(record).toMatchObject({
      builtAt,
      ciRunId: 37877507979,
      compatibility: { comparedWith: null, reasons: [], rollbackBarrier: false },
      deployer: { image: deployer },
      label: "2026.10.09-0123456",
      publishedAt: "2026-10-09T04:02:10.000Z",
      releaseManifestSha256: digest,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      version: 1,
    });
    expect(Object.keys(record.files)).toEqual([
      "agent-email-runtime.zip",
      "agent-runtime.zip",
      "app-domains.zip",
      "apps-database.zip",
      "build-info.json",
      "channel-provider-runtime.zip",
      "console-assets.zip",
      "console.zip",
      "document-extraction.zip",
      "event-analytics-projector.zip",
      "event-dispatcher.zip",
      "identity-api.zip",
      "identity-email-worker.zip",
      "images/firecrawl.dynamodb-table.json",
      "images/firecrawl.oci.tar",
      "manifest.json",
      "memory-runtime.zip",
      "ops-alerts-notifier.zip",
      "platform-api.zip",
      "release.json",
    ]);
    expect(record.files["images/firecrawl.oci.tar"]).toEqual({
      sha256: "806c800a82a1a7e5594537d66ff4550736e66b0dd028c197e10d9bafb206d71b",
      sizeBytes: 15,
    });
    expect(record.files["release.json"]?.sha256).toBe(digest);

    const prefix = `releases/${digest}/`;
    expect(await store.headObject(`${prefix}images/firecrawl.oci.tar`)).toEqual({
      sha256: "806c800a82a1a7e5594537d66ff4550736e66b0dd028c197e10d9bafb206d71b",
      sizeBytes: 15,
    });
    expect(await store.getObjectTags(`${prefix}platform-api.zip`)).toEqual({
      object: "payload",
      retention: "dev",
    });
    expect(await store.getObjectTags(`${prefix}release-record.json`)).toEqual({
      retention: "dev",
    });
    expect(await store.getObjectTags(`${prefix}release-record.sig.json`)).toEqual({
      retention: "dev",
    });
    const storedRecord = await readObjectBytes(store, `${prefix}release-record.json`);
    const storedSignature = await readObjectBytes(store, `${prefix}release-record.sig.json`);
    if (!storedRecord || !storedSignature) throw new Error("record and signature were not stored");
    expect(decodeReleaseRecord(storedRecord)).toEqual(record);
    const signature = decodeReleaseSignature(storedSignature);
    expect(signature.keyId).toBe("arn:aws:kms:us-east-2:123456789012:key/test");
    expect(
      verifyReleaseSignature({
        publicKey: await signer.publicKey(),
        record: storedRecord,
        signature,
      }),
    ).toBe(true);
  });

  test("converges on rerun: a record differing only in when and by which run is kept and signed", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const first = await publish(store, bundle, { deployerImage: deployer });
    const { signer } = localSigner(temporaryDirectory());

    const rerun = await publish(store, bundle, {
      ciRunId: 99,
      deployerImage: deployer,
      now: () => new Date("2026-10-10T00:00:00.000Z"),
      signer,
    });

    expect(rerun).toEqual(first);
    expect(rerun.publishedAt).toBe("2026-10-09T04:02:10.000Z");
    const signature = await readObjectBytes(
      store,
      `releases/${first.releaseManifestSha256}/release-record.sig.json`,
    );
    expect(signature && decodeReleaseSignature(signature).keyId).toBe(
      "arn:aws:kms:us-east-2:123456789012:key/test",
    );
  });

  test("converges on rerun after the bucket gained an earlier-built release: the stored compatibility is kept", async () => {
    const store = memoryRegistryStore();
    const { signer } = localSigner(temporaryDirectory());
    const bundle = writeFixtureBundle(temporaryDirectory(), {
      builtAt,
      sourceCommit: "3".repeat(40),
    });
    const first = await publish(store, bundle, { signer });
    await publishFixture({
      builtAt: "2026-10-05T00:00:00.000Z",
      bundle: temporaryDirectory(),
      signer,
      sourceCommit: "2".repeat(40),
      store,
    });

    const rerun = await publish(store, bundle, {
      compatibilityReasons: async () => [{ kind: "deploy-migration", name: "installation-record" }],
      signer,
    });

    expect(rerun).toEqual(first);
    expect(rerun.compatibility).toEqual({
      comparedWith: null,
      reasons: [],
      rollbackBarrier: false,
    });
  });

  test("converges on rerun without a deployer image: the stored deployer is kept and signed", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const first = await publish(store, bundle, { deployerImage: deployer });
    const { signer } = localSigner(temporaryDirectory());

    const rerun = await publish(store, bundle, { signer });

    expect(rerun).toEqual(first);
    expect(rerun.deployer).toEqual({ image: deployer });
    const signature = await readObjectBytes(
      store,
      `releases/${first.releaseManifestSha256}/release-record.sig.json`,
    );
    expect(signature && decodeReleaseSignature(signature).keyId).toBe(
      "arn:aws:kms:us-east-2:123456789012:key/test",
    );
  });

  test("finishes a publish that stopped after uploading some files", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const releaseJson = new Uint8Array(readFileSync(join(bundle, "release.json")));
    const digest = sha256(releaseJson);
    await store.putObject({
      body: { bytes: releaseJson, kind: "bytes" },
      key: `releases/${digest}/release.json`,
      sha256: digest,
      tags: { retention: "dev" },
    });

    const record = await publish(store, bundle);

    expect(record.releaseManifestSha256).toBe(digest);
    expect(await store.headObject(`releases/${digest}/release-record.json`)).not.toBeUndefined();
  });

  test("refuses to adopt an object stored with different content", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const other = new TextEncoder().encode("{}");
    await store.putObject({
      body: { bytes: other, kind: "bytes" },
      key: `releases/${digest}/manifest.json`,
      sha256: sha256(other),
      tags: {},
    });

    expect(await rejectionMessage(publish(store, bundle))).toBe(
      `releases/${digest}/manifest.json already exists with different content.`,
    );
    expect(await store.headObject(`releases/${digest}/release-record.json`)).toBeUndefined();
  });

  test("compares with the newest earlier release and records its barrier reasons", async () => {
    const store = memoryRegistryStore();
    const first = await publishFixture({
      builtAt: "2026-10-01T00:00:00.000Z",
      bundle: temporaryDirectory(),
      sourceCommit: "1".repeat(40),
      store,
    });
    const previous = await publishFixture({
      builtAt: "2026-10-05T00:00:00.000Z",
      bundle: temporaryDirectory(),
      sourceCommit: "2".repeat(40),
      store,
    });
    await publishFixture({
      builtAt: "2026-10-20T00:00:00.000Z",
      bundle: temporaryDirectory(),
      sourceCommit: "4".repeat(40),
      store,
    });
    const compared: string[][] = [];
    const bundle = writeFixtureBundle(temporaryDirectory(), {
      builtAt,
      sourceCommit: "3".repeat(40),
    });

    const record = await publish(store, bundle, {
      compatibilityReasons: async (from, to) => {
        compared.push([from, to]);
        return [{ kind: "deploy-migration", name: "installation-record" }];
      },
    });

    expect(first.compatibility.comparedWith).toBeNull();
    expect(compared).toEqual([["2".repeat(40), "3".repeat(40)]]);
    expect(record.compatibility).toEqual({
      comparedWith: previous.releaseManifestSha256,
      reasons: [{ kind: "deploy-migration", name: "installation-record" }],
      rollbackBarrier: true,
    });
  });

  test("refuses bundles that are not a complete build", async () => {
    const store = memoryRegistryStore();
    const unstamped = writeFixtureBundle(temporaryDirectory());
    expect(await rejectionMessage(publish(store, unstamped))).toStartWith(
      `Invalid build-info.json in ${unstamped}:`,
    );
    const partial = writeFixtureBundle(temporaryDirectory(), {
      builtAt,
      images: ["durable-streams", "firecrawl"],
    });
    rmSync(join(partial, "images/firecrawl.oci.tar"));
    expect(await rejectionMessage(publish(store, partial))).toBe(
      "Refusing to publish without the firecrawl images.",
    );
    expect(await store.listChildNames("releases/")).toEqual([]);
  });

  test("publishes the platform console build of a commit and refuses its install-supplied console build", async () => {
    const memory = memoryRegistryStore();
    const writes: string[] = [];
    const store: RegistryStore = {
      ...memory,
      async putObject(input) {
        writes.push(input.key);
        return await memory.putObject(input);
      },
      async putObjectTags(key, tags) {
        writes.push(key);
        await memory.putObjectTags(key, tags);
      },
    };
    const install = writeFixtureBundle(temporaryDirectory(), { builtAt, consoleBuild: "install" });
    expect(await rejectionMessage(publish(store, install))).toBe(
      `Refusing to publish ${digestOf(install)}: its console is an install-supplied build, and customers install releases from the registry. Publish the platform build of 0123456789abcdef0123456789abcdef01234567 instead, built by release build without DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR.`,
    );
    expect(writes).toEqual([]);

    const platform = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const record = await publish(store, platform);
    expect(record.releaseManifestSha256).toBe(digestOf(platform));
    expect(record.sourceCommit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(writes.at(-1)).toBe(`releases/${digestOf(platform)}/release-record.json`);
  });

  test("refuses a stored signature that the signing key does not verify", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const stranger = localSigner(temporaryDirectory(), "arn:aws:kms:us-east-2:123456789012:key/x");
    await publish(store, bundle, { signer: stranger.signer });
    const { signer } = localSigner(temporaryDirectory());

    expect(publish(store, bundle, { signer })).rejects.toThrow(
      "release-record.sig.json exists but does not verify with the configured signing key.",
    );
  });

  test("refuses a stored record this run would not write, and signs nothing", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const planted = `111122223333.dkr.ecr.us-east-2.amazonaws.com/planted@sha256:${"ef".repeat(32)}`;
    await publish(store, bundle, { deployerImage: planted });
    const { signer } = localSigner(temporaryDirectory());

    expect(
      await rejectionMessage(publish(store, bundle, { deployerImage: deployer, signer })),
    ).toBe(
      `Release ${digest} already has a record this run would not write; it differs in deployer.`,
    );
    expect(await store.headObject(`releases/${digest}/release-record.sig.json`)).toBeUndefined();
  });

  test("refuses a stored record that differs in what the bundle determines, whatever compatibility and deployer it keeps", async () => {
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const record = await publish(memoryRegistryStore(), bundle);
    const store = memoryRegistryStore();
    const planted = encodeReleaseRecord({
      ...record,
      compatibility: {
        comparedWith: "ab".repeat(32),
        reasons: [{ kind: "deploy-migration", name: "installation-record" }],
        rollbackBarrier: true,
      },
      deployer: { image: deployer },
      files: { ...record.files, "manifest.json": { sha256: "ef".repeat(32), sizeBytes: 2 } },
    });
    await store.putObject({
      body: { bytes: planted, kind: "bytes" },
      key: `releases/${digest}/release-record.json`,
      sha256: sha256(planted),
      tags: { retention: "dev" },
    });

    expect(await rejectionMessage(publish(store, bundle))).toBe(
      `Release ${digest} already has a record this run would not write; it differs in files.`,
    );
  });

  test("refuses a stored record with this run's fields in other bytes", async () => {
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const record = await publish(memoryRegistryStore(), bundle);
    const store = memoryRegistryStore();
    const compact = new TextEncoder().encode(JSON.stringify(record));
    await store.putObject({
      body: { bytes: compact, kind: "bytes" },
      key: `releases/${digest}/release-record.json`,
      sha256: sha256(compact),
      tags: { retention: "dev" },
    });

    expect(await rejectionMessage(publish(store, bundle))).toBe(
      `Release ${digest} already has a record this run would not write; it differs in its JSON encoding.`,
    );
  });

  test("checks a record that another publish wrote between this run's read and write", async () => {
    const memory = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const recordKey = `releases/${digest}/release-record.json`;
    const planted = `111122223333.dkr.ecr.us-east-2.amazonaws.com/planted@sha256:${"ef".repeat(32)}`;
    const racing: RegistryStore = {
      ...memory,
      async putObject(input) {
        if (input.key === recordKey && !(await memory.headObject(recordKey))) {
          await publish(memory, bundle, { deployerImage: planted });
        }
        return await memory.putObject(input);
      },
    };
    const { signer } = localSigner(temporaryDirectory());

    expect(
      await rejectionMessage(publish(racing, bundle, { deployerImage: deployer, signer })),
    ).toBe(
      `Release ${digest} already has a record this run would not write; it differs in deployer.`,
    );
    expect(await memory.headObject(`releases/${digest}/release-record.sig.json`)).toBeUndefined();
  });

  test("writes no record when signing fails, so a rerun with a rebuilt deployer converges", async () => {
    const store = memoryRegistryStore();
    const bundle = writeFixtureBundle(temporaryDirectory(), { builtAt });
    const digest = digestOf(bundle);
    const { signer } = localSigner(temporaryDirectory());
    const throttled: ReleaseSigner = {
      publicKey: () => signer.publicKey(),
      sign: async () => {
        throw new Error("ThrottlingException: Rate exceeded");
      },
    };
    const rebuilt = `123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/deployer@sha256:${"ab".repeat(32)}`;

    expect(
      await rejectionMessage(
        publish(store, bundle, { deployerImage: deployer, signer: throttled }),
      ),
    ).toBe("ThrottlingException: Rate exceeded");
    expect(await store.headObject(`releases/${digest}/release-record.json`)).toBeUndefined();

    const record = await publish(store, bundle, { deployerImage: rebuilt, signer });
    expect(record.deployer).toEqual({ image: rebuilt });
    const signature = await readObjectBytes(store, `releases/${digest}/release-record.sig.json`);
    expect(signature && decodeReleaseSignature(signature).keyId).toBe(
      "arn:aws:kms:us-east-2:123456789012:key/test",
    );
  });

  test("with a signer or public key, compares only with an earlier release it can verify", async () => {
    const withSigner = await predecessorChoice(({ signer }) => ({ signer }));
    expect(withSigner.compared).toEqual([["1".repeat(40), "3".repeat(40)]]);
    expect(withSigner.comparedWith).toBe(withSigner.signed.releaseManifestSha256);

    const withPublicKey = await predecessorChoice(({ publicKeyPath }) => ({
      signingPublicKeyPath: publicKeyPath,
    }));
    expect(withPublicKey.compared).toEqual([["1".repeat(40), "3".repeat(40)]]);
    expect(withPublicKey.comparedWith).toBe(withPublicKey.signed.releaseManifestSha256);

    const withoutKey = await predecessorChoice(() => ({}));
    expect(withoutKey.compared).toEqual([["4".repeat(40), "3".repeat(40)]]);
    expect(withoutKey.comparedWith).toBe(withoutKey.misSigned.releaseManifestSha256);
  });
});
