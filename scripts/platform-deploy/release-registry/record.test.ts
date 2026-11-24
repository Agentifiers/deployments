import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeReleaseRecord,
  decodeReleaseSignature,
  encodeReleaseRecord,
  releaseLabel,
  type ReleaseRecordSignature,
} from "./record.ts";

const example = readFileSync(join(import.meta.dir, "record.fixture.json"));
const exampleDocument = JSON.parse(example.toString("utf8"));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("release record v1", () => {
  test("decodes the contract example and writes it back in contract field order", () => {
    const record = decodeReleaseRecord(example);
    expect(record.compatibility.reasons).toEqual([
      { count: 3, file: "infrastructure/modules/x/main.tf", kind: "terraform-moved" },
      { file: "packages/db/src/records/system.ts", kind: "record-schema" },
      { kind: "deploy-migration", name: "installation-record" },
    ]);
    const written = JSON.parse(new TextDecoder().decode(encodeReleaseRecord(record)));
    expect(written).toEqual(exampleDocument);
    expect(Object.keys(written)).toEqual([
      "version",
      "releaseManifestSha256",
      "sourceCommit",
      "label",
      "builtAt",
      "publishedAt",
      "ciRunId",
      "sizeBytes",
      "files",
      "compatibility",
      "deployer",
    ]);
  });

  test("accepts a first release with no predecessor, no CI run, and no deployer", () => {
    const record = decodeReleaseRecord(
      encode({
        ...exampleDocument,
        ciRunId: null,
        compatibility: { comparedWith: null, reasons: [], rollbackBarrier: false },
        deployer: null,
      }),
    );
    expect([record.ciRunId, record.compatibility.comparedWith, record.deployer]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("rejects shapes outside the contract", () => {
    expect(() => decodeReleaseRecord(encode({ ...exampleDocument, channel: "stable" }))).toThrow(
      "channel",
    );
    expect(() =>
      decodeReleaseRecord(
        encode({
          ...exampleDocument,
          compatibility: { ...exampleDocument.compatibility, reasons: [] },
        }),
      ),
    ).toThrow("rollbackBarrier must be true exactly when reasons is non-empty.");
    expect(() =>
      decodeReleaseRecord(
        encode({
          ...exampleDocument,
          files: { "../release.json": exampleDocument.files["release.json"] },
        }),
      ),
    ).toThrow("../release.json");
    expect(() =>
      decodeReleaseRecord(
        encode({ ...exampleDocument, deployer: { image: "registry/deployer:latest" } }),
      ),
    ).toThrow("registry/deployer:latest");
  });

  test("labels a release with its UTC build date and short commit", () => {
    expect(
      releaseLabel("2026-10-09T23:59:59.999Z", "640b8f91a97f1eca492c7415ea4fdd648249336d"),
    ).toBe("2026.10.09-640b8f9");
  });
});

describe("release record signature v1", () => {
  test("decodes the contract shape and rejects other algorithms or extra fields", () => {
    const signature: ReleaseRecordSignature = {
      algorithm: "ECDSA_SHA_256",
      keyId: "arn:aws:kms:us-east-2:123456789012:key/0000",
      signature: "MEUCIQ==",
      version: 1,
    };
    expect(decodeReleaseSignature(encode(signature))).toEqual(signature);
    expect(() =>
      decodeReleaseSignature(encode({ ...signature, algorithm: "RSASSA_PSS_SHA_256" })),
    ).toThrow("RSASSA_PSS_SHA_256");
    expect(() => decodeReleaseSignature(encode({ ...signature, digest: "sha256" }))).toThrow(
      "digest",
    );
  });
});
