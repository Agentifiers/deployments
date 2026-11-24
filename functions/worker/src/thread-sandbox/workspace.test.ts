import { describe, expect, test } from "bun:test";
import type { RuntimeSandboxPolicy } from "@deployments-ai/agent-runtime";
import {
  DatabaseError,
  SandboxLeaseRecord,
  makeSandboxWorkspacePersistence,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type SandboxWorkspacePersistence,
  ObservabilitySourceContext,
  type TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import {
  managedSandboxFromRecord,
  type SandboxLeaseRecordValue,
} from "@deployments-ai/sandbox-hosts";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import type { ThreadSandboxScope } from "./contracts.ts";
import type { ThreadSandboxSnapshotRef, ThreadSandboxSnapshotStore } from "./snapshot-store.ts";
import { makeThreadSandboxWorkspace, type ThreadSandboxWorkspaceOptions } from "./workspace.ts";

const id = (suffix: number) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${String(suffix).padStart(4, "0")}`);
const START = Date.parse("2026-09-29T12:00:00.000Z");
const LEASE_TTL_MS = 8 * 60 * 60_000;
const scope = {
  environmentId: id(2),
  executionTargetId: id(1),
  executionTargetKind: "agent-deployment" as const,
  organizationId: id(3),
  projectId: id(4),
  runId: id(5),
  threadId: id(6),
} satisfies ThreadSandboxScope;
const policy: RuntimeSandboxPolicy = { mode: "thread-persistent", provider: "aws_lambda_microvm" };
const observability = Schema.decodeUnknownSync(ObservabilitySourceContext)({
  captureMode: "metadata-only",
  runSpanId: "0123456789abcdef",
  sessionId: scope.threadId,
  traceId: "0123456789abcdef0123456789abcdef",
});
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function storageKey(pk: string, sk: string) {
  return `${pk}\u0000${sk}`;
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const database = {
    getRecord: async (_table: string, requested: { readonly pk: string; readonly sk: string }) =>
      records.get(storageKey(requested.pk, requested.sk)),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        expect(tableForItemType(operation.record.itemType)).toBe("execution");
        const existing = records.get(storageKey(operation.record.pk, operation.record.sk));
        const previous = operation.previousRecord;
        const stale = previous
          ? !existing || JSON.stringify(existing) !== JSON.stringify(previous)
          : existing !== undefined;
        if (stale) {
          throw new DatabaseError({
            cause: new Error("ConditionalCheckFailed"),
            message: "Conditional write failed.",
            operation: "transact-write",
            reason: "conflict",
            table: "execution",
          });
        }
      }
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        records.set(storageKey(operation.record.pk, operation.record.sk), operation.record);
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records };
}

function leaseRecord(
  leaseId: string,
  runId: string,
  timestamp: number,
  overrides: Record<string, unknown> = {},
): SandboxLeaseRecordValue {
  const at = new Date(timestamp).toISOString();
  return Schema.decodeUnknownSync(SandboxLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        computeUsageActive: true,
        createdAt: at,
        environmentId: scope.environmentId,
        executionTargetId: scope.executionTargetId,
        executionTargetKind: scope.executionTargetKind,
        externalSandboxId: `vm-${leaseId}`,
        id: leaseId,
        isolationMode: "thread-persistent",
        leaseExpiresAt: new Date(timestamp + LEASE_TTL_MS).toISOString(),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        provider: "aws_lambda_microvm",
        runId,
        status: "ready",
        updatedAt: at,
        usageStartedAt: at,
        version: 0,
        ...overrides,
      },
      itemType: "sandbox-lease",
    }),
  );
}

type JobStatus = Readonly<Record<string, unknown>>;
type JobSpec = Readonly<Record<string, unknown>> & { readonly op: string };

const objectKey = (url: unknown) => new URL(String(url)).pathname.slice(1);

/**
 * Fakes the in-sandbox transfer program: uploads of `spec.json` define the job, `start` runs it,
 * and `status` reports its outcome (optionally overridden per operation).
 */
function harness() {
  const { database, records } = memoryDatabase();
  const persistence = makeSandboxWorkspacePersistence(database);
  let clock = START;
  let nextId = 100;
  const state = {
    archive: encode("archive-bytes-1"),
    confirmFails: false,
    createFails: false,
    destroyFails: false,
    status: {} as Partial<Record<"archive" | "restore" | "upload", JobStatus>>,
    /** Milliseconds each `status` poll of a running job advances the clock. */
    runningPollAdvanceMs: 60_000,
  };
  const calls = {
    creates: [] as Record<string, unknown>[],
    destroyed: [] as string[],
    jobs: [] as JobSpec[],
    restored: [] as Uint8Array[],
  };
  const objects = new Map<string, Uint8Array>();
  let spec: JobSpec | undefined;
  let job: JobSpec | undefined;
  const putLease = (record: SandboxLeaseRecordValue) =>
    records.set(storageKey(record.pk, record.sk), record);
  const reply = (value: unknown) => ({
    durationMs: 1,
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify(value)}\n`,
  });
  const jobStatus = (current: JobSpec): JobStatus => {
    const override = state.status[current.op as "archive" | "restore" | "upload"];
    if (override?.state === "running") clock += state.runningPollAdvanceMs;
    if (override) return override;
    if (current.op === "archive") {
      return { byteSize: state.archive.byteLength, sha256: digest(state.archive), state: "done" };
    }
    if (current.op === "upload") objects.set(objectKey(current.url), state.archive);
    if (current.op === "restore") calls.restored.push(objects.get(objectKey(current.url))!);
    return { state: "done" };
  };
  const manager = {
    create: (input: Record<string, unknown>) =>
      Effect.suspend(() => {
        calls.creates.push(input);
        if (state.createFails) return Effect.fail(new Error("capacity"));
        const record = leaseRecord(String(input.allocationId), String(input.runId), clock);
        putLease(record);
        return Effect.succeed(managedSandboxFromRecord(record));
      }),
    destroy: (sandbox: { record: SandboxLeaseRecordValue }) =>
      Effect.suspend(() => {
        if (state.destroyFails) return Effect.fail(new Error("terminate failed"));
        calls.destroyed.push(sandbox.record.data.id);
        const destroyed = leaseRecord(sandbox.record.data.id, sandbox.record.data.runId!, clock, {
          computeUsageActive: false,
          status: "destroyed",
          version: sandbox.record.data.version + 1,
        });
        putLease(destroyed);
        return Effect.succeed(destroyed);
      }),
    exec: (input: { command: readonly string[] }) =>
      Effect.sync(() => {
        const [, , action] = input.command;
        if (action === "start") {
          job = spec;
          calls.jobs.push(spec!);
          return reply({ state: "started" });
        }
        return reply(job ? jobStatus(job) : { state: "missing" });
      }),
    upload: (input: { content: Uint8Array; path: string }) =>
      Effect.sync(() => {
        if (input.path.endsWith("/spec.json")) {
          spec = JSON.parse(new TextDecoder().decode(input.content)) as JobSpec;
        }
      }),
  } as unknown as ThreadSandboxWorkspaceOptions["manager"];
  const deletedObjects: string[] = [];
  let versions = 0;
  const snapshots: ThreadSandboxSnapshotStore = {
    confirmUpload: async (object) => {
      if (state.confirmFails || !objects.has(object.key)) throw new Error("mismatch");
      versions += 1;
      return { ...object, bucket: "artifacts", versionId: `v${versions}` };
    },
    delete: async (ref) => {
      deletedObjects.push(ref.key);
      objects.delete(ref.key);
    },
    presignDownload: async (ref) => `https://s3.test/${ref.key}?versionId=${ref.versionId}`,
    presignUpload: async ({ key }) => ({
      headers: { "if-none-match": "*" },
      url: `https://s3.test/${key}?X-Amz-Signature=sig`,
    }),
  };
  const options = {
    generateId: async () => id(nextId++),
    manager,
    now: () => clock,
    persistence,
    providerName: "aws_lambda_microvm" as const,
    snapshots,
  };
  const seedSnapshot = async (bytes: Uint8Array): Promise<ThreadSandboxSnapshotRef> => {
    const key = `organizations/${scope.organizationId}/sandbox-workspaces/seed.tar.gz`;
    objects.set(key, bytes);
    versions += 1;
    const ref = {
      bucket: "artifacts",
      byteSize: bytes.byteLength,
      key,
      sha256: digest(bytes),
      versionId: `v${versions}`,
    };
    const at = new Date(START).toISOString();
    await persistence.create({
      createdAt: at,
      environmentId: scope.environmentId,
      executionTargetId: scope.executionTargetId,
      executionTargetKind: scope.executionTargetKind,
      id: id(90),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      snapshot: { ...ref, capturedAt: at, leaseId: id(91) },
      threadId: scope.threadId,
      updatedAt: at,
    });
    return ref;
  };
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    calls,
    deletedObjects,
    load: () => persistence.load(scope),
    now: () => clock,
    objects,
    options,
    persistence,
    putLease,
    seedSnapshot,
    state,
    workspace: makeThreadSandboxWorkspace(options),
  };
}

const ops = (jobs: readonly JobSpec[]) => jobs.map((job) => job.op);

describe("thread sandbox workspace", () => {
  test("first acquire allocates a restored-marked lease without a snapshot", async () => {
    const h = harness();
    const sandbox = await h.workspace.acquire({ ...scope, observability, policy });

    const workspace = await h.load();
    expect(h.calls.creates).toHaveLength(1);
    expect(h.calls.creates[0]).toMatchObject({
      allocationId: workspace?.data.leaseId,
      isolationMode: "thread-persistent",
      observability,
      runId: scope.runId,
    });
    expect(sandbox.record.data.id).toBe(workspace!.data.leaseId!);
    expect(workspace?.data.leaseRunId).toBe(scope.runId);
    expect(workspace?.data.restoredLeaseId).toBe(workspace!.data.leaseId!);
    expect(h.calls.jobs).toEqual([]);
  });

  test("acquire has the sandbox download, verify, and extract the committed snapshot", async () => {
    const h = harness();
    const seeded = await h.seedSnapshot(encode("previous-workspace"));

    await h.workspace.acquire({ ...scope, observability, policy });

    expect(h.calls.jobs).toEqual([
      expect.objectContaining({
        byteSize: seeded.byteSize,
        op: "restore",
        root: "/workspace",
        sha256: seeded.sha256,
        url: `https://s3.test/${seeded.key}?versionId=${seeded.versionId}`,
      }),
    ]);
    expect(h.calls.restored).toEqual([encode("previous-workspace")]);
    const workspace = await h.load();
    expect(workspace?.data.restoredLeaseId).toBe(workspace!.data.leaseId!);
  });

  test("a failed restore leaves the lease unrestored so run exit destroys it without a snapshot", async () => {
    const h = harness();
    await h.seedSnapshot(encode("previous-workspace"));
    h.state.status.restore = { reason: "digest_mismatch", state: "failed" };

    expect(h.workspace.acquire({ ...scope, observability, policy })).rejects.toThrow(
      "restore did not complete (digest_mismatch)",
    );
    const failed = await h.load();
    expect(failed?.data.restoredLeaseId).toBeUndefined();

    await h.workspace.release(scope);
    const released = await h.load();
    expect(ops(h.calls.jobs)).toEqual(["restore"]);
    expect(h.calls.destroyed).toEqual([failed!.data.leaseId!]);
    expect(released?.data.leaseId).toBeUndefined();
    expect(released?.data.snapshot?.versionId).toBe("v1");
  });

  test("the same run reuses its lease, including concurrent tool calls", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.workspace.acquire({ ...scope, observability, policy }),
      h.workspace.acquire({ ...scope, observability, policy }),
    ]);
    const third = await h.workspace.acquire({ ...scope, observability, policy });

    expect(h.calls.creates).toHaveLength(1);
    expect(second.record.data.id).toBe(first.record.data.id);
    expect(third.record.data.id).toBe(first.record.data.id);
  });

  test("a different run salvages the previous lease and restores its snapshot onto a fresh one", async () => {
    const h = harness();
    const first = await h.workspace.acquire({ ...scope, observability, policy });
    const nextRunId = id(50);

    const second = await h.workspace.acquire({ ...scope, observability, policy, runId: nextRunId });

    expect(h.calls.destroyed).toEqual([first.record.data.id]);
    expect(second.record.data.id).not.toBe(first.record.data.id);
    expect(ops(h.calls.jobs)).toEqual(["archive", "upload", "restore"]);
    expect(h.calls.restored).toEqual([h.state.archive]);
    const workspace = await h.load();
    expect(workspace?.data.snapshot?.leaseId).toBe(first.record.data.id);
    expect(workspace?.data.leaseRunId).toBe(nextRunId);
    expect(workspace?.data.restoredLeaseId).toBe(second.record.data.id);
  });

  test("a run-scoped release leaves a sandbox that a later run of the thread leased", async () => {
    const h = harness();
    await h.workspace.acquire({ ...scope, observability, policy });
    const later = await h.workspace.acquire({ ...scope, observability, policy, runId: id(50) });
    const destroyedBefore = [...h.calls.destroyed];

    await h.workspace.release(scope, { onlyIfLeasedByRun: true });
    expect(h.calls.destroyed).toEqual(destroyedBefore);
    expect((await h.load())?.data.leaseId).toBe(later.record.data.id);

    await h.workspace.release({ ...scope, runId: id(50) }, { onlyIfLeasedByRun: true });
    expect(h.calls.destroyed).toEqual([...destroyedBefore, later.record.data.id]);
  });

  test("a lease within 15 minutes of expiry is salvaged instead of reused", async () => {
    const h = harness();
    const first = await h.workspace.acquire({ ...scope, observability, policy });
    h.advance(LEASE_TTL_MS - 14 * 60_000);

    const second = await h.workspace.acquire({ ...scope, observability, policy });

    expect(h.calls.creates).toHaveLength(2);
    expect(h.calls.destroyed).toEqual([first.record.data.id]);
    expect(ops(h.calls.jobs)).toEqual(["archive", "upload", "restore"]);
    expect(second.record.data.id).not.toBe(first.record.data.id);
  });

  test("release uploads the archive from the sandbox, commits it, destroys, and deletes the superseded object", async () => {
    const h = harness();
    const seeded = await h.seedSnapshot(encode("previous-workspace"));
    const sandbox = await h.workspace.acquire({ ...scope, observability, policy });
    h.state.archive = encode("archive-after-run");

    await h.workspace.release(scope);

    const workspace = await h.load();
    const [, archive, upload] = h.calls.jobs;
    expect(archive).toMatchObject({ op: "archive", root: "/workspace" });
    expect(upload).toMatchObject({
      file: archive!.output,
      headers: { "if-none-match": "*" },
      op: "upload",
    });
    expect(h.calls.destroyed).toEqual([sandbox.record.data.id]);
    expect(workspace?.data.leaseId).toBeUndefined();
    expect(workspace?.data.leaseRunId).toBeUndefined();
    expect(workspace?.data.restoredLeaseId).toBeUndefined();
    expect(workspace?.data.snapshot).toMatchObject({
      byteSize: h.state.archive.byteLength,
      leaseId: sandbox.record.data.id,
      sha256: digest(h.state.archive),
      versionId: "v2",
    });
    expect(objectKey(upload!.url)).toBe(workspace!.data.snapshot!.key);
    expect(workspace?.data.snapshot?.key).toStartWith(
      `organizations/${scope.organizationId}/sandbox-workspaces/projects/${scope.projectId}/`,
    );
    expect(h.objects.get(workspace!.data.snapshot!.key)).toEqual(h.state.archive);
    expect(h.deletedObjects).toEqual([seeded.key]);
  });

  test.each([
    [
      "an oversized archive",
      { archive: { state: "too_large" } },
      "archive-too-large",
      "Workspace snapshot exceeds 5 GiB compressed.",
    ],
    [
      "a failed archive",
      { archive: { reason: "os_ENOSPC", state: "failed" } },
      "snapshot-incomplete",
      "Workspace snapshot archive failed in the sandbox (os_ENOSPC).",
    ],
    [
      "a rejected upload",
      { upload: { reason: "http_403_AccessDenied", state: "failed" } },
      "snapshot-incomplete",
      "Workspace snapshot upload failed in the sandbox (http_403_AccessDenied).",
    ],
    [
      "an archive still running at the deadline",
      { archive: { state: "running" } },
      "snapshot-incomplete",
      "Workspace snapshot archive did not finish before the release deadline.",
    ],
  ] as const)(
    "%s records the failure and keeps the sandbox alive",
    async (_label, status, code, reason) => {
      const h = harness();
      const sandbox = await h.workspace.acquire({ ...scope, observability, policy });
      h.state.status = status;

      await h.workspace.release(scope, { deadline: h.now() + 30_000 });

      const workspace = await h.load();
      expect(h.calls.destroyed).toEqual([]);
      expect(workspace?.data.leaseId).toBe(sandbox.record.data.id);
      expect(workspace?.data.snapshot).toBeUndefined();
      expect(workspace?.data.lastSnapshotFailure).toMatchObject({
        code,
        leaseId: sandbox.record.data.id,
        reason,
      });
    },
  );

  test("an upload whose stored object does not match is a snapshot failure", async () => {
    const h = harness();
    await h.workspace.acquire({ ...scope, observability, policy });
    h.state.confirmFails = true;

    await h.workspace.release(scope);

    expect(h.calls.destroyed).toEqual([]);
    expect((await h.load())?.data.lastSnapshotFailure?.code).toBe("snapshot-failed");
  });

  test("a release without enough time left skips the snapshot and keeps the sandbox", async () => {
    const h = harness();
    const sandbox = await h.workspace.acquire({ ...scope, observability, policy });

    await h.workspace.release(scope, { deadline: h.now() + 5_000 });

    const workspace = await h.load();
    expect(h.calls.jobs).toEqual([]);
    expect(h.calls.destroyed).toEqual([]);
    expect(workspace?.data.lastSnapshotFailure).toMatchObject({
      code: "snapshot-incomplete",
      leaseId: sandbox.record.data.id,
    });
  });

  test.each([
    ["too large", { archive: { state: "too_large" } }],
    ["incomplete", { upload: { reason: "http_500_InternalError", state: "failed" } }],
  ] as const)(
    "the next run carries forward a healthy sandbox whose snapshot was %s",
    async (_label, status) => {
      const h = harness();
      const first = await h.workspace.acquire({ ...scope, observability, policy });
      h.state.status = status;
      await h.workspace.release(scope);
      const jobsBefore = h.calls.jobs.length;

      const second = await h.workspace.acquire({ ...scope, observability, policy, runId: id(50) });

      expect(second.record.data.id).toBe(first.record.data.id);
      expect(h.calls.creates).toHaveLength(1);
      expect(h.calls.jobs).toHaveLength(jobsBefore);
      expect((await h.load())?.data.leaseRunId).toBe(id(50));
    },
  );

  test("a successful snapshot clears a previously recorded failure", async () => {
    const h = harness();
    await h.workspace.acquire({ ...scope, observability, policy });
    h.state.status = { upload: { reason: "http_500_InternalError", state: "failed" } };
    await h.workspace.release(scope);
    h.state.status = {};

    await h.workspace.release(scope);

    const workspace = await h.load();
    expect(workspace?.data.lastSnapshotFailure).toBeUndefined();
    expect(workspace?.data.snapshot?.versionId).toBe("v1");
    expect(workspace?.data.leaseId).toBeUndefined();
  });

  test("a sandbox whose snapshot keeps failing verification is abandoned by the next run", async () => {
    const h = harness();
    const first = await h.workspace.acquire({ ...scope, observability, policy });
    h.state.confirmFails = true;

    const second = await h.workspace.acquire({ ...scope, observability, policy, runId: id(50) });

    const workspace = await h.load();
    expect(h.calls.destroyed).toEqual([]);
    expect(second.record.data.id).not.toBe(first.record.data.id);
    expect(workspace?.data.leaseId).toBe(second.record.data.id);
    expect(workspace?.data.restoredLeaseId).toBe(second.record.data.id);
  });

  test("a destroy failure keeps the lease recorded after committing the snapshot", async () => {
    const h = harness();
    const sandbox = await h.workspace.acquire({ ...scope, observability, policy });
    h.state.destroyFails = true;

    await h.workspace.release(scope);

    const workspace = await h.load();
    expect(workspace?.data.snapshot?.leaseId).toBe(sandbox.record.data.id);
    expect(workspace?.data.leaseId).toBe(sandbox.record.data.id);
  });

  test("an unready lease is destroyed without a snapshot", async () => {
    const h = harness();
    const sandbox = await h.workspace.acquire({ ...scope, observability, policy });
    h.putLease(
      leaseRecord(sandbox.record.data.id, scope.runId, START, { status: "error", version: 1 }),
    );

    await h.workspace.release(scope);
    expect(h.calls.jobs).toEqual([]);
    expect(h.calls.destroyed).toEqual([sandbox.record.data.id]);
    expect((await h.load())?.data.leaseId).toBeUndefined();
  });

  test("allocation failure surfaces as a runtime error", async () => {
    const h = harness();
    h.state.createFails = true;

    expect(h.workspace.acquire({ ...scope, observability, policy })).rejects.toThrow(
      "Thread sandbox allocation did not complete.",
    );
  });

  test("rejects policies that are not thread-persistent on the configured provider", async () => {
    const h = harness();
    expect(
      h.workspace.acquire({
        ...scope,
        observability,
        policy: { ...policy, mode: "run-ephemeral" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(
      h.workspace.acquire({
        ...scope,
        observability,
        policy: { ...policy, provider: "unconfigured" as typeof policy.provider },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(h.calls.creates).toEqual([]);
  });

  test("release never throws when persistence fails", async () => {
    const h = harness();
    const failing: SandboxWorkspacePersistence = {
      ...h.persistence,
      load: async () => {
        throw new DatabaseError({
          cause: new Error("throttled"),
          message: "Read failed.",
          operation: "get",
          reason: "unknown",
          table: "execution",
        });
      },
    };
    const workspace = makeThreadSandboxWorkspace({ ...h.options, persistence: failing });

    expect(workspace.release(scope)).resolves.toBeUndefined();
  });
});
