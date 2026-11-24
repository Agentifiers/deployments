import { describe, expect, test } from "bun:test";
import { memoryRegistryStore } from "./memory-store.ts";
import {
  localSigner,
  publishFixture,
  rejectionMessage,
  useTemporaryDirectories,
} from "./registry.fixture.ts";
import { retainRelease } from "./retain.ts";

const temporaryDirectory = useTemporaryDirectories();

describe("release retain", () => {
  test("retags every object of the release for customers and is a no-op on rerun", async () => {
    const store = memoryRegistryStore();
    const { signer } = localSigner(temporaryDirectory());
    const record = await publishFixture({
      builtAt: "2026-10-09T03:51:43.000Z",
      bundle: temporaryDirectory(),
      signer,
      store,
    });
    const other = await publishFixture({
      builtAt: "2026-10-10T00:00:00.000Z",
      bundle: temporaryDirectory(),
      store,
    });
    const digest = record.releaseManifestSha256;

    expect(await retainRelease({ releaseManifestSha256: digest, store })).toEqual({
      objects: 24,
      retagged: 24,
    });
    const keys = [...Object.keys(record.files), "release-record.json", "release-record.sig.json"];
    const tags = await Promise.all(
      keys.map((file) => store.getObjectTags(`releases/${digest}/${file}`)),
    );
    expect(new Set(tags.map(({ retention }) => retention))).toEqual(new Set(["customer"]));
    expect(await store.getObjectTags(`releases/${digest}/platform-api.zip`)).toEqual({
      object: "payload",
      retention: "customer",
    });
    expect(await store.getObjectTags(`releases/${digest}/release-record.json`)).toEqual({
      retention: "customer",
    });
    expect(
      await store.getObjectTags(`releases/${other.releaseManifestSha256}/release-record.json`),
    ).toEqual({ retention: "dev" });
    expect(await retainRelease({ releaseManifestSha256: digest, store })).toEqual({
      objects: 24,
      retagged: 0,
    });
  });

  test("keeps a retained release through the lifecycle and refuses one that expired", async () => {
    const store = memoryRegistryStore();
    const { signer } = localSigner(temporaryDirectory());
    const retained = await publishFixture({
      builtAt: "2026-10-09T03:51:43.000Z",
      bundle: temporaryDirectory(),
      signer,
      store,
    });
    const expired = await publishFixture({
      builtAt: "2026-10-10T00:00:00.000Z",
      bundle: temporaryDirectory(),
      store,
    });
    await retainRelease({ releaseManifestSha256: retained.releaseManifestSha256, store });
    store.runLifecycle();

    expect(
      await retainRelease({ releaseManifestSha256: retained.releaseManifestSha256, store }),
    ).toEqual({ objects: 24, retagged: 0 });
    expect(
      await rejectionMessage(
        retainRelease({ releaseManifestSha256: expired.releaseManifestSha256, store }),
      ),
    ).toBe(
      `Release 2026.10.10-0123456 (${expired.releaseManifestSha256}) has expired: the lifecycle removed 22 of its 22 files.`,
    );
    expect(
      await store.getObjectTags(`releases/${expired.releaseManifestSha256}/release-record.json`),
    ).toEqual({ retention: "dev" });
  });

  test("refuses a release that was never published", async () => {
    const digest = "9".repeat(64);
    expect(
      retainRelease({ releaseManifestSha256: digest, store: memoryRegistryStore() }),
    ).rejects.toThrow(`Release ${digest} is not published.`);
  });
});
