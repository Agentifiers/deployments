import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_INPUT_ARTIFACT_BYTES,
  putOutcome,
  runUpload,
  sha256Hex,
  type PutResult,
  type UploadPorts,
  type UploadState,
} from "./upload.ts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ARTIFACT = "01K000000000000000000000F1";
const EXPIRED_BODY =
  "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>";
const BAD_DIGEST =
  "<Error><Code>BadDigest</Code><Message>The SHA256 you specified did not match the calculated checksum.</Message></Error>";

function ports(overrides: Partial<UploadPorts> = {}) {
  const calls: string[] = [];
  const base: UploadPorts = {
    complete: async (artifactId) => {
      calls.push(`complete ${artifactId}`);
      return {};
    },
    create: async (sha256) => {
      calls.push(`create ${sha256}`);
      return {
        artifactId: ARTIFACT,
        upload: { expiresAt: "2026-11-02T12:15:00.000Z", headers: {}, url: "https://s3.test/a" },
      };
    },
    now: () => NOW,
    put: async (_target, onProgress) => {
      calls.push("put");
      onProgress(5);
      onProgress(10);
      return { body: "", status: 200 };
    },
    sha256: async () => "a".repeat(64),
  };
  return { calls, ports: { ...base, ...overrides } };
}

async function upload(overrides: Partial<UploadPorts> = {}, size = 10) {
  const { calls, ports: chosen } = ports(overrides);
  const states: UploadState[] = [];
  const final = await runUpload(size, MAX_ARTIFACT_BYTES, chosen, (state) => states.push(state));
  return { calls, final, kinds: states.map((state) => state.kind), states };
}

const putting = (result: PutResult): Partial<UploadPorts> => ({ put: async () => result });

describe("artifact upload", () => {
  test("hashes, creates, sends with progress, then completes", async () => {
    const { calls, final, kinds, states } = await upload();
    expect(kinds).toEqual([
      "hashing",
      "creating",
      "sending",
      "sending",
      "sending",
      "completing",
      "done",
    ]);
    expect(states.filter((state) => state.kind === "sending")).toEqual([
      { artifactId: ARTIFACT, kind: "sending", sent: 0, total: 10 },
      { artifactId: ARTIFACT, kind: "sending", sent: 5, total: 10 },
      { artifactId: ARTIFACT, kind: "sending", sent: 10, total: 10 },
    ]);
    expect(calls).toEqual([`create ${"a".repeat(64)}`, "put", `complete ${ARTIFACT}`]);
    expect(final).toEqual({ artifactId: ARTIFACT, kind: "done" });
  });

  test("refuses an empty or too-large file before contacting the platform", async () => {
    const empty = await upload({}, 0);
    expect(empty.final).toEqual({ kind: "failed", problem: { kind: "empty" } });
    expect(empty.calls).toEqual([]);
    const large = await upload({}, MAX_ARTIFACT_BYTES + 1);
    expect(large.final).toEqual({
      kind: "failed",
      problem: { kind: "too-large", limit: MAX_ARTIFACT_BYTES },
    });
    expect(large.calls).toEqual([]);
  });

  test("reports a hash mismatch from storage and from verification", async () => {
    const atStorage = await upload(putting({ body: BAD_DIGEST, status: 400 }));
    expect(atStorage.final).toEqual({
      artifactId: ARTIFACT,
      kind: "failed",
      problem: { kind: "hash-mismatch" },
    });
    expect(atStorage.calls).not.toContain(`complete ${ARTIFACT}`);

    const atCompletion = await upload({
      complete: () =>
        Promise.reject(
          new PlatformApiError("completeArtifactUpload", {
            code: "artifact_upload_mismatch",
            status: 409,
            title: "Artifact upload does not match",
          }),
        ),
    });
    expect(atCompletion.final).toEqual({
      artifactId: ARTIFACT,
      kind: "failed",
      problem: { kind: "hash-mismatch" },
    });
  });

  test("reports an expired upload URL", async () => {
    const atStorage = await upload(putting({ body: EXPIRED_BODY, status: 403 }));
    expect(atStorage.final).toEqual({
      artifactId: ARTIFACT,
      kind: "failed",
      problem: { kind: "expired" },
    });

    const beforeSending = await upload({
      create: async () => ({
        artifactId: ARTIFACT,
        upload: { expiresAt: "2026-11-02T11:59:59.000Z", headers: {}, url: "https://s3.test/a" },
      }),
    });
    expect(beforeSending.final).toMatchObject({ kind: "failed", problem: { kind: "expired" } });
    expect(beforeSending.calls).not.toContain("put");
  });

  test("reports a network failure while sending or reaching the platform", async () => {
    expect((await upload(putting({ body: "", status: 0 }))).final).toEqual({
      artifactId: ARTIFACT,
      kind: "failed",
      problem: { kind: "network" },
    });
    expect(
      (await upload({ create: () => Promise.reject(new TypeError("Failed to fetch")) })).final,
    ).toEqual({ kind: "failed", problem: { kind: "network" } });
  });

  test("treats an object an earlier attempt stored as sent", () => {
    expect(putOutcome({ body: "", status: 412 })).toBe("stored");
    expect(putOutcome({ body: "<Error><Code>AccessDenied</Code></Error>", status: 403 })).toEqual({
      kind: "rejected",
      message: "The storage service refused the file (AccessDenied).",
    });
  });

  test("names the platform's own size limit, and passes other refusals through", async () => {
    const tooLarge = await upload({
      create: () =>
        Promise.reject(
          new PlatformApiError("createArtifactUpload", {
            code: "input_file_too_large",
            detail: "Input files must not exceed 10 MiB.",
            status: 413,
            title: "Input file too large",
          }),
        ),
    });
    expect(tooLarge.final).toEqual({
      kind: "failed",
      problem: { kind: "too-large", limit: MAX_INPUT_ARTIFACT_BYTES },
    });
    const refused = await upload({
      complete: () =>
        Promise.reject(
          new PlatformApiError("completeArtifactUpload", {
            code: "input_file_unsupported_type",
            detail: "The file type cannot be read as input.",
            status: 422,
            title: "Unusable input",
          }),
        ),
    });
    expect(refused.final).toEqual({
      artifactId: ARTIFACT,
      kind: "failed",
      problem: { kind: "rejected", message: "The file type cannot be read as input." },
    });
  });

  test("computes the lowercase hex SHA-256 of the file", async () => {
    expect(await sha256Hex(new Blob(["abc"]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
