import { describe, expect, test } from "bun:test";
import { attemptAfterFailure, freshAttempt } from "../components/keyed-attempt.ts";
import { snapshotFor } from "../components/keyed-snapshot.ts";
import { PlatformApiError } from "../errors.ts";
import {
  credentialDocument,
  rotationSender,
  type CredentialFieldView,
  type RotationRequest,
} from "./credential-form.ts";

const field = (
  key: string,
  label: string,
  overrides: Partial<CredentialFieldView> = {},
): CredentialFieldView => ({
  key,
  label,
  multiline: false,
  required: true,
  sensitive: false,
  ...overrides,
});

const DEMIO = [
  field("accountLabel", "Account label"),
  field("apiKey", "API key", { sensitive: true }),
  field("apiSecret", "API secret", { sensitive: true }),
];

describe("credentialDocument", () => {
  test("builds the credential from trimmed values", () => {
    expect(
      credentialDocument(DEMIO, { accountLabel: " acme ", apiKey: "k", apiSecret: "s\n" }),
    ).toEqual({ credential: { accountLabel: "acme", apiKey: "k", apiSecret: "s" }, ok: true });
  });

  test("names every missing required field", () => {
    expect(
      credentialDocument(DEMIO, { accountLabel: "acme", apiKey: "  ", apiSecret: "s" }),
    ).toEqual({ ok: false, problems: ["API key is required."] });
  });

  test("omits an empty optional field and lets the API fill a default", () => {
    expect(
      credentialDocument(
        [
          field("apiKey", "API key", { sensitive: true }),
          field("region", "Region", { defaultValue: "us" }),
          field("note", "Note", { required: false }),
        ],
        { apiKey: "k", note: "", region: "" },
      ),
    ).toEqual({ credential: { apiKey: "k" }, ok: true });
  });

  test("sends no credential for a provider without fields", () => {
    expect(credentialDocument([], { apiKey: "k" })).toEqual({ ok: true });
  });
});

type Fault =
  | "ok"
  | "throttled"
  | "unavailable"
  | "writeCancelled"
  | "cleanupConflict"
  | "lostAfterRotating";

/**
 * `POST /v1/connections/:id/rotate-credential`: the first write stores the credential, bumps the
 * version, and binds the pending cleanup to the request's body and key; only that request can
 * finish the cleanup. A cancelled first write answers `version_conflict` and leaves the version.
 * A finished request's key replays its outcome.
 */
function rotationApi() {
  const state = {
    pending: undefined as string | undefined,
    requests: 0,
    rotations: 0,
    stored: "old",
    version: 0,
  };
  const sent: string[] = [];
  const finished = new Set<string>();
  const refuse = (status: number, code: string) =>
    Promise.reject(new PlatformApiError("rotateProviderCredential", { code, status, title: "T" }));
  const rotate = (request: RotationRequest, fault: Fault) => {
    state.requests += 1;
    sent.push(request.value.credential.apiKey ?? "");
    if (fault === "throttled") return refuse(429, "rate_limited");
    const fingerprint = JSON.stringify(request);
    if (finished.has(fingerprint)) return Promise.resolve("rotated");
    if (state.pending === undefined) {
      if (fault === "unavailable") return refuse(500, "internal_error");
      if (request.value.expectedVersion !== state.version) return refuse(409, "version_conflict");
      if (fault === "writeCancelled") return refuse(409, "version_conflict");
      state.version += 1;
      state.pending = fingerprint;
      state.stored = request.value.credential.apiKey ?? "";
    } else if (state.pending !== fingerprint) {
      return refuse(409, "rotation_cleanup_pending");
    }
    if (fault === "cleanupConflict") return refuse(409, "version_conflict");
    state.pending = undefined;
    state.version += 1;
    state.rotations += 1;
    finished.add(fingerprint);
    return fault === "lostAfterRotating" ? refuse(502, "bad_gateway") : Promise.resolve("rotated");
  };
  return { rotate, sent, state };
}

/**
 * A rotate dialog: its keyed attempt, the body snapshot, and the re-read of the version on 409.
 * Each submission's sends take `faults` in order; the last one repeats.
 */
function rotateDialog(
  api: ReturnType<typeof rotationApi>,
  liveVersion = () => Promise.resolve(api.state.version),
) {
  const rotate = rotationSender(liveVersion);
  let attempt = freshAttempt();
  let held: RotationRequest | undefined;
  let version = 0;
  return async (apiKey: string, ...faults: [Fault, ...Fault[]]) => {
    held = snapshotFor(held, attempt.key, attempt.state === "resend", {
      credential: { apiKey },
      expectedVersion: version,
    });
    try {
      return await rotate(held, (request) =>
        api.rotate(request, (faults.length > 1 ? faults.shift() : faults[0]) ?? "ok"),
      );
    } catch (error) {
      if (!(error instanceof PlatformApiError)) throw error;
      attempt = attemptAfterFailure(attempt, error);
      if (error.problem.status === 409) version = api.state.version;
      return error.problem.code;
    }
  };
}

describe("rotationSender", () => {
  test("finishes a rotation whose cleanup conflicted twice on a resend", async () => {
    const api = rotationApi();
    const submit = rotateDialog(api);
    expect([
      await submit("new", "unavailable"),
      await submit("new", "cleanupConflict"),
      await submit("new", "ok"),
    ]).toEqual(["internal_error", "version_conflict", "rotated"]);
    expect(api.state).toEqual({
      pending: undefined,
      requests: 5,
      rotations: 1,
      stored: "new",
      version: 2,
    });
  });

  test("finishes a rotation whose cleanup conflicted twice on the first submit", async () => {
    const api = rotationApi();
    const submit = rotateDialog(api);
    expect([await submit("new", "cleanupConflict"), await submit("new", "ok")]).toEqual([
      "version_conflict",
      "rotated",
    ]);
    expect(api.state).toEqual({
      pending: undefined,
      requests: 4,
      rotations: 1,
      stored: "new",
      version: 2,
    });
  });

  test("an earlier request that finished behind a lost response replays instead of rotating again", async () => {
    const api = rotationApi();
    const submit = rotateDialog(api);
    expect([
      await submit("new", "cleanupConflict"),
      await submit("new", "lostAfterRotating"),
      await submit("new", "ok"),
    ]).toEqual(["version_conflict", "bad_gateway", "rotated"]);
    expect(api.state).toEqual({
      pending: undefined,
      requests: 7,
      rotations: 1,
      stored: "new",
      version: 2,
    });
  });

  test("a version conflict before the first write is retried once and then reported", async () => {
    const api = rotationApi();
    api.state.version = 3;
    const submit = rotateDialog(api);
    expect([await submit("new", "ok"), await submit("new", "ok")]).toEqual([
      "version_conflict",
      "rotated",
    ]);
    expect(api.state).toEqual({
      pending: undefined,
      requests: 3,
      rotations: 1,
      stored: "new",
      version: 5,
    });
  });

  test("a refused request with nothing to resend reports the refusal without reading the version", async () => {
    const api = rotationApi();
    api.state.version = 3;
    let reads = 0;
    const submit = rotateDialog(api, () => {
      reads += 1;
      return Promise.reject(
        new PlatformApiError("getProviderConnection", {
          code: "internal_error",
          status: 500,
          title: "T",
        }),
      );
    });
    expect([await submit("new", "ok"), reads]).toEqual(["version_conflict", 0]);
  });

  test("a corrected credential whose write was cancelled does not send the credential it replaced", async () => {
    const api = rotationApi();
    const submit = rotateDialog(api);
    expect([
      await submit("wrong", "throttled"),
      // The third fault exists only so that resending "wrong", as the old sender did, would succeed.
      await submit("right", "writeCancelled", "writeCancelled", "ok"),
      await submit("right", "ok"),
    ]).toEqual(["rate_limited", "version_conflict", "rotated"]);
    expect({ sent: api.sent, state: api.state }).toEqual({
      sent: ["wrong", "right", "right", "right"],
      state: { pending: undefined, requests: 4, rotations: 1, stored: "right", version: 2 },
    });
  });

  test("finishes a pending rotation from the newest earlier request first", async () => {
    const api = rotationApi();
    const submit = rotateDialog(api);
    expect([
      await submit("a", "throttled"),
      await submit("b", "throttled"),
      await submit("c", "cleanupConflict"),
      await submit("d", "ok"),
    ]).toEqual(["rate_limited", "rate_limited", "version_conflict", "rotated"]);
    expect({ sent: api.sent, state: api.state }).toEqual({
      sent: ["a", "b", "c", "c", "b", "a", "d", "c"],
      state: { pending: undefined, requests: 8, rotations: 1, stored: "c", version: 2 },
    });
  });
});
