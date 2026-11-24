import { describe, expect, test } from "bun:test";
import { memoryRegistryStore } from "./memory-store.ts";
import {
  localSigner,
  publishFixture,
  rejectionMessage,
  useTemporaryDirectories,
} from "./registry.fixture.ts";
import { verifyPublishedRelease } from "./verify.ts";

const temporaryDirectory = useTemporaryDirectories();

describe("release verify in the registry", () => {
  test("checks the signature, release.json, and every stored checksum without downloading", async () => {
    const store = memoryRegistryStore();
    const { publicKeyPath, signer } = localSigner(temporaryDirectory());
    const record = await publishFixture({
      builtAt: "2026-10-09T03:51:43.000Z",
      bundle: temporaryDirectory(),
      signer,
      store,
    });
    const digest = record.releaseManifestSha256;

    expect(
      (
        await verifyPublishedRelease({
          releaseManifestSha256: digest,
          signingPublicKeyPath: publicKeyPath,
          store,
        })
      ).label,
    ).toBe("2026.10.09-0123456");

    const stranger = localSigner(temporaryDirectory(), "arn:aws:kms:us-east-2:123456789012:key/x");
    expect(
      await rejectionMessage(
        verifyPublishedRelease({
          releaseManifestSha256: digest,
          signingPublicKeyPath: stranger.publicKeyPath,
          store,
        }),
      ),
    ).toBe(`Release ${digest} signature does not match ${stranger.publicKeyPath}.`);

    store.expire(`releases/${digest}/images/durable-streams.oci.tar`);
    expect(
      await rejectionMessage(
        verifyPublishedRelease({
          releaseManifestSha256: digest,
          signingPublicKeyPath: undefined,
          store,
        }),
      ),
    ).toBe(
      `Release 2026.10.09-0123456 (${digest}) has expired: the lifecycle removed 1 of its 22 files.`,
    );
  });
});
