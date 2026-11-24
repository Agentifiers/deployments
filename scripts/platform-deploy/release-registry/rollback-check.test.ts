import { describe, expect, test } from "bun:test";
import { memoryRegistryStore } from "./memory-store.ts";
import {
  type CompatibilityReason,
  encodeReleaseRecord,
  encodeReleaseSignature,
  releaseObjectKey,
  releaseRecordFile,
  releaseSignatureFile,
  type ReleaseRecord,
} from "./record.ts";
import { localSigner, publishFixture, useTemporaryDirectories } from "./registry.fixture.ts";
import { retainRelease } from "./retain.ts";
import { checkRollback } from "./rollback-check.ts";
import type { ReleaseSigner } from "./signing.ts";
import type { RegistryStore } from "./store.ts";

const temporaryDirectory = useTemporaryDirectories();
const deployer = `123456789012.dkr.ecr.us-east-2.amazonaws.com/deployments-ai/platform/deployer@sha256:${"cd".repeat(32)}`;

async function history() {
  const store = memoryRegistryStore();
  const publish = (builtAt: string, extra: Partial<Parameters<typeof publishFixture>[0]> = {}) =>
    publishFixture({ builtAt, bundle: temporaryDirectory(), store, ...extra });
  const first = await publish("2026-10-01T00:00:00.000Z");
  const barrier = await publish("2026-10-02T00:00:00.000Z", {
    reasons: [
      { count: 2, file: "infrastructure/modules/platform/moved.tf", kind: "terraform-moved" },
      { kind: "deploy-migration", name: "installation-record" },
    ],
  });
  const third = await publish("2026-10-03T00:00:00.000Z", { deployerImage: deployer });
  const fourth = await publish("2026-10-04T00:00:00.000Z");
  return { barrier, first, fourth, store, third };
}

async function signedHistory() {
  const store = memoryRegistryStore();
  const keys = temporaryDirectory();
  const { publicKeyPath, signer } = localSigner(keys);
  const stranger = localSigner(keys, "arn:aws:kms:us-east-2:123456789012:key/stranger");
  const publish = (builtAt: string, extra: Partial<Parameters<typeof publishFixture>[0]> = {}) =>
    publishFixture({ builtAt, bundle: temporaryDirectory(), signer, store, ...extra });
  const first = await publish("2026-10-01T00:00:00.000Z");
  const barrier = await publish("2026-10-02T00:00:00.000Z", {
    reasons: [
      { count: 2, file: "infrastructure/modules/platform/moved.tf", kind: "terraform-moved" },
    ],
  });
  const third = await publish("2026-10-03T00:00:00.000Z", { deployerImage: deployer });
  const unsigned = await publish("2026-10-04T00:00:00.000Z", {
    reasons: [{ kind: "deploy-migration", name: "forged" }],
    signer: undefined,
  });
  const misSigned = await publish("2026-10-05T00:00:00.000Z", { signer: stranger.signer });
  const sixth = await publish("2026-10-06T00:00:00.000Z");
  return { barrier, first, misSigned, publicKeyPath, sixth, store, third, unsigned };
}

async function signOutOfBand(store: RegistryStore, signer: ReleaseSigner, record: ReleaseRecord) {
  const { keyId, signature } = await signer.sign(encodeReleaseRecord(record));
  const bytes = encodeReleaseSignature({
    algorithm: "ECDSA_SHA_256",
    keyId,
    signature: Buffer.from(signature).toString("base64"),
    version: 1,
  });
  await store.putObject({
    body: { bytes, kind: "bytes" },
    key: releaseObjectKey(record.releaseManifestSha256, releaseSignatureFile),
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    tags: {},
  });
}

async function twoHundredDayChain(reasons: readonly CompatibilityReason[]) {
  const store = memoryRegistryStore();
  const { publicKeyPath, signer } = localSigner(temporaryDirectory());
  const publish = (builtAt: string, extra: Partial<Parameters<typeof publishFixture>[0]> = {}) =>
    publishFixture({ builtAt, bundle: temporaryDirectory(), signer, store, ...extra });
  const customer = await publish("2026-03-23T00:00:00.000Z");
  const may = await publish("2026-05-01T00:00:00.000Z");
  const july = await publish("2026-07-15T00:00:00.000Z", { reasons });
  const latest = await publish("2026-10-09T00:00:00.000Z");
  for (const { releaseManifestSha256 } of [customer, latest]) {
    await retainRelease({ releaseManifestSha256, store });
  }
  store.runLifecycle();
  return { customer, july, latest, may, publicKeyPath, store };
}

describe("release rollback-check", () => {
  test("allows a rollback that crosses no barrier and names the target's deployer", async () => {
    const { fourth, store, third } = await history();
    const decision = await checkRollback({
      from: fourth.releaseManifestSha256,
      signingPublicKeyPath: undefined,
      store,
      to: third.releaseManifestSha256,
    });
    expect(decision.kind).toBe("allowed");
    expect(decision.kind === "allowed" && decision.target.deployer).toEqual({ image: deployer });
  });

  test("allows a rollback along a complete chain that crosses no barrier", async () => {
    const { barrier, fourth, store } = await history();
    expect(
      await checkRollback({
        from: fourth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: barrier.releaseManifestSha256,
      }),
    ).toEqual({ kind: "allowed", target: barrier });
  });

  test("refuses a rollback across a barrier release", async () => {
    const { barrier, first, fourth, store } = await history();
    expect(
      await checkRollback({
        from: fourth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: first.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release 2026.10.02-0123456 (${barrier.releaseManifestSha256}) is a rollback barrier: 2 moved blocks in infrastructure/modules/platform/moved.tf; deploy migration installation-record.`,
      ],
    });
    expect(
      (
        await checkRollback({
          from: barrier.releaseManifestSha256,
          signingPublicKeyPath: undefined,
          store,
          to: first.releaseManifestSha256,
        })
      ).kind,
    ).toBe("refused");
  });

  test("checks a rollback from a version 4 release to a version 3 release", async () => {
    const store = memoryRegistryStore();
    const older = await publishFixture({
      builtAt: "2026-10-01T00:00:00.000Z",
      bundle: temporaryDirectory(),
      store,
      version: 3,
    });
    const newer = await publishFixture({
      builtAt: "2026-10-02T00:00:00.000Z",
      bundle: temporaryDirectory(),
      store,
    });
    const check = (from: ReleaseRecord, to: ReleaseRecord) =>
      checkRollback({
        from: from.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: to.releaseManifestSha256,
      });
    expect(await check(newer, older)).toEqual({ kind: "allowed", target: older });
    expect(await check(older, newer)).toEqual({
      kind: "refused",
      reasons: ["Target release 2026.10.02-0123456 is newer than the running 2026.10.01-0123456."],
    });
  });

  test("refuses a newer, unpublished, or expired target and an unknown running release", async () => {
    const { first, fourth, store, third } = await history();
    expect(
      await checkRollback({
        from: third.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: fourth.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: ["Target release 2026.10.04-0123456 is newer than the running 2026.10.03-0123456."],
    });
    const missing = "9".repeat(64);
    expect(
      await checkRollback({
        from: fourth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: missing,
      }),
    ).toEqual({ kind: "refused", reasons: [`Target release ${missing} is not published.`] });
    expect(
      await checkRollback({
        from: missing,
        signingPublicKeyPath: undefined,
        store,
        to: first.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [`Running release ${missing} is not published, so its barriers are unknown.`],
    });
    store.expire(`releases/${third.releaseManifestSha256}/images/firecrawl.oci.tar`);
    expect(
      await checkRollback({
        from: fourth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: third.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        "Target release 2026.10.03-0123456 has expired: the lifecycle removed 1 of its 22 files.",
      ],
    });
  });

  test("refuses when a release on the chain has no record, naming its digest", async () => {
    const { barrier, first, fourth, store } = await history();
    store.expire(releaseObjectKey(barrier.releaseManifestSha256, releaseRecordFile));
    expect(
      await checkRollback({
        from: fourth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: first.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release ${barrier.releaseManifestSha256} is not published, so the barriers between 2026.10.03-0123456 and the target are unknown.`,
      ],
    });
  });

  test("allows a rollback 200 days back through expired dev releases that carry no barrier", async () => {
    const { customer, latest, may, publicKeyPath, store } = await twoHundredDayChain([]);
    for (const signingPublicKeyPath of [publicKeyPath, undefined]) {
      expect(
        await checkRollback({
          from: latest.releaseManifestSha256,
          signingPublicKeyPath,
          store,
          to: customer.releaseManifestSha256,
        }),
      ).toEqual({ kind: "allowed", target: customer });
    }
    expect(
      await checkRollback({
        from: latest.releaseManifestSha256,
        signingPublicKeyPath: publicKeyPath,
        store,
        to: may.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        "Target release 2026.05.01-0123456 has expired: the lifecycle removed 22 of its 22 files.",
      ],
    });
  });

  test("refuses a rollback across a barrier on an expired dev release", async () => {
    const { customer, july, latest, publicKeyPath, store } = await twoHundredDayChain([
      { kind: "deploy-migration", name: "installation-record" },
    ]);
    expect(
      await checkRollback({
        from: latest.releaseManifestSha256,
        signingPublicKeyPath: publicKeyPath,
        store,
        to: customer.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release 2026.07.15-0123456 (${july.releaseManifestSha256}) is a rollback barrier: deploy migration installation-record.`,
      ],
    });
  });

  test("refuses when the chain ends or passes the target without reaching it", async () => {
    const { misSigned, sixth, store, third, unsigned } = await signedHistory();
    expect(
      await checkRollback({
        from: misSigned.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: third.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release 2026.10.05-0123456 (${misSigned.releaseManifestSha256}) was compared with no earlier release, so its chain never reaches the target.`,
      ],
    });
    expect(
      await checkRollback({
        from: sixth.releaseManifestSha256,
        signingPublicKeyPath: undefined,
        store,
        to: unsigned.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release 2026.10.06-0123456 (${sixth.releaseManifestSha256}) was compared with ${third.releaseManifestSha256}, which was not built between the target and it, so its chain never reaches the target.`,
      ],
    });
  });

  test("takes barriers only from the chain, so a record off it adds none", async () => {
    const { barrier, first, publicKeyPath, sixth, store, third } = await signedHistory();
    for (const signingPublicKeyPath of [publicKeyPath, undefined]) {
      expect(
        await checkRollback({
          from: sixth.releaseManifestSha256,
          signingPublicKeyPath,
          store,
          to: third.releaseManifestSha256,
        }),
      ).toEqual({ kind: "allowed", target: third });
    }
    expect(
      await checkRollback({
        from: sixth.releaseManifestSha256,
        signingPublicKeyPath: publicKeyPath,
        store,
        to: first.releaseManifestSha256,
      }),
    ).toEqual({
      kind: "refused",
      reasons: [
        `Release 2026.10.02-0123456 (${barrier.releaseManifestSha256}) is a rollback barrier: 2 moved blocks in infrastructure/modules/platform/moved.tf.`,
      ],
    });
  });

  test("with a signing key, refuses a chain through an unsigned release", async () => {
    const store = memoryRegistryStore();
    const { publicKeyPath, signer } = localSigner(temporaryDirectory());
    const publish = (builtAt: string) =>
      publishFixture({ builtAt, bundle: temporaryDirectory(), store });
    const first = await publish("2026-10-01T00:00:00.000Z");
    const middle = await publish("2026-10-02T00:00:00.000Z");
    const third = await publish("2026-10-03T00:00:00.000Z");
    await signOutOfBand(store, signer, first);
    await signOutOfBand(store, signer, third);
    const check = (signingPublicKeyPath: string | undefined) =>
      checkRollback({
        from: third.releaseManifestSha256,
        signingPublicKeyPath,
        store,
        to: first.releaseManifestSha256,
      });

    expect(await check(publicKeyPath)).toEqual({
      kind: "refused",
      reasons: [
        `Release ${middle.releaseManifestSha256} is unsigned, so the barriers between 2026.10.03-0123456 and the target are unknown.`,
      ],
    });
    expect(await check(undefined)).toEqual({ kind: "allowed", target: first });
  });

  test("with a signing key, refuses an unsigned or mis-signed target or running release", async () => {
    const { first, misSigned, publicKeyPath, sixth, store, third, unsigned } =
      await signedHistory();
    const check = (from: string, to: string) =>
      checkRollback({ from, signingPublicKeyPath: publicKeyPath, store, to });

    expect(await check(sixth.releaseManifestSha256, unsigned.releaseManifestSha256)).toEqual({
      kind: "refused",
      reasons: [`Target release ${unsigned.releaseManifestSha256} is unsigned.`],
    });
    expect(await check(sixth.releaseManifestSha256, misSigned.releaseManifestSha256)).toEqual({
      kind: "refused",
      reasons: [
        `Target release ${misSigned.releaseManifestSha256} signature does not match ${publicKeyPath}.`,
      ],
    });
    expect(await check(unsigned.releaseManifestSha256, first.releaseManifestSha256)).toEqual({
      kind: "refused",
      reasons: [
        `Running release ${unsigned.releaseManifestSha256} is unsigned, so its barriers are unknown.`,
      ],
    });
    expect(await check(misSigned.releaseManifestSha256, third.releaseManifestSha256)).toEqual({
      kind: "refused",
      reasons: [
        `Running release ${misSigned.releaseManifestSha256} signature does not match ${publicKeyPath}, so its barriers are unknown.`,
      ],
    });
  });
});
