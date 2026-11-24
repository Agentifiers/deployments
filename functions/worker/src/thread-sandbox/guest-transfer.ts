import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  runSandboxJob,
  type SandboxJobContext,
  type SandboxJobOutcome,
} from "../sandbox-job-runner.ts";
import { THREAD_SANDBOX_WORKSPACE_ROOT } from "./contracts.ts";
import { WORKSPACE_TRANSFER_SCRIPT } from "./guest-transfer-script.ts";
import type { ThreadSandboxSnapshotRef, ThreadSandboxSnapshotStore } from "./snapshot-store.ts";

/** Disk-backed scratch space outside `/workspace`, so archives never include themselves. */
const WORKSPACE_TRANSFER_DIRECTORY = "/var/tmp/deployments-ai-workspace-transfer";
const SCRIPT_PATH = `${WORKSPACE_TRANSFER_DIRECTORY}/transfer.py`;
const SPEC_PATH = `${WORKSPACE_TRANSFER_DIRECTORY}/spec.json`;
const SNAPSHOT_ARCHIVE_PATH = `${WORKSPACE_TRANSFER_DIRECTORY}/snapshot.tar.gz`;
const RESTORE_ARCHIVE_PATH = `${WORKSPACE_TRANSFER_DIRECTORY}/restore.tar.gz`;

/** A snapshot failure whose message is a fixed, secret-free reason safe to persist. */
export class ThreadSandboxSnapshotFailure extends Error {
  override readonly name = "ThreadSandboxSnapshotFailure";

  constructor(
    message: string,
    readonly code: "archive-too-large" | "snapshot-failed" | "snapshot-incomplete",
  ) {
    super(message);
  }
}

const Reason = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_A-Z]{1,96}$/u)));

const GuestJobStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["missing", "running", "started", "too_large"]) }),
  Schema.Struct({ reason: Reason, state: Schema.Literal("failed") }),
  Schema.Struct({
    byteSize: Schema.optional(Schema.Number.pipe(Schema.check(Schema.isInt()))),
    sha256: Schema.optional(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)))),
    state: Schema.Literal("done"),
  }),
]);
type GuestJobOutcome = SandboxJobOutcome<typeof GuestJobStatus.Type>;
const decodeGuestJobStatus = Schema.decodeUnknownSync(GuestJobStatus);

type GuestJobSpec =
  | {
      readonly maxBytes: number;
      readonly op: "archive";
      readonly output: string;
      readonly root: string;
    }
  | {
      readonly file: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly op: "upload";
      readonly url: string;
    }
  | {
      readonly byteSize: number;
      readonly file: string;
      readonly op: "restore";
      readonly root: string;
      readonly sha256: string;
      readonly url: string;
    };

type TransferContext = SandboxJobContext;

/**
 * Runs one detached transfer job inside the sandbox and polls it until it settles or the
 * deadline passes. Presigned URLs travel only in the uploaded spec file, never on a command line.
 */
function runGuestJob(context: TransferContext, spec: GuestJobSpec): Promise<GuestJobOutcome> {
  return runSandboxJob(context, {
    control: ["python3", SCRIPT_PATH],
    decodeStatus: decodeGuestJobStatus,
    label: "Workspace transfer",
    startArgument: SPEC_PATH,
    statusArgument: WORKSPACE_TRANSFER_DIRECTORY,
    uploads: [
      { content: WORKSPACE_TRANSFER_SCRIPT, path: SCRIPT_PATH },
      { content: JSON.stringify(spec), path: SPEC_PATH },
    ],
  });
}

/**
 * Archives `/workspace` inside the sandbox, has the sandbox upload it straight to S3 through a
 * presigned create-only `PutObject` pinned to the archive's SHA-256, and confirms the stored
 * object. Archive bytes never pass through the worker.
 */
export async function captureWorkspaceSnapshot(
  context: TransferContext & {
    readonly key: string;
    readonly snapshots: ThreadSandboxSnapshotStore;
  },
): Promise<ThreadSandboxSnapshotRef> {
  const archived = await runGuestJob(context, {
    maxBytes: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
    op: "archive",
    output: SNAPSHOT_ARCHIVE_PATH,
    root: THREAD_SANDBOX_WORKSPACE_ROOT,
  });
  if (archived.state === "too_large") {
    throw new ThreadSandboxSnapshotFailure(
      "Workspace snapshot exceeds 5 GiB compressed.",
      "archive-too-large",
    );
  }
  const byteSize = archived.state === "done" ? archived.byteSize : undefined;
  const sha256 = archived.state === "done" ? archived.sha256 : undefined;
  if (archived.state !== "done" || byteSize === undefined || sha256 === undefined) {
    throw incomplete("archive", archived);
  }
  const upload = await context.snapshots.presignUpload({ byteSize, key: context.key, sha256 });
  const uploaded = await runGuestJob(context, {
    file: SNAPSHOT_ARCHIVE_PATH,
    headers: upload.headers,
    op: "upload",
    url: upload.url,
  });
  if (uploaded.state !== "done") throw incomplete("upload", uploaded);
  return context.snapshots.confirmUpload({ byteSize, key: context.key, sha256 }, context.signal);
}

/** Has the sandbox download, verify, and extract the snapshot into `/workspace`. */
export async function restoreWorkspaceSnapshot(
  context: TransferContext & {
    readonly snapshot: ThreadSandboxSnapshotRef;
    readonly snapshots: ThreadSandboxSnapshotStore;
  },
) {
  const restored = await runGuestJob(context, {
    byteSize: context.snapshot.byteSize,
    file: RESTORE_ARCHIVE_PATH,
    op: "restore",
    root: THREAD_SANDBOX_WORKSPACE_ROOT,
    sha256: context.snapshot.sha256,
    url: await context.snapshots.presignDownload(context.snapshot),
  });
  if (restored.state !== "done") {
    throw new Error(
      `Thread sandbox workspace restore did not complete (${restored.state === "failed" ? restored.reason : restored.state}).`,
    );
  }
}

function incomplete(phase: "archive" | "upload", outcome: GuestJobOutcome) {
  return new ThreadSandboxSnapshotFailure(
    outcome.state === "timeout"
      ? `Workspace snapshot ${phase} did not finish before the release deadline.`
      : `Workspace snapshot ${phase} failed in the sandbox (${outcome.state === "failed" ? outcome.reason : outcome.state}).`,
    "snapshot-incomplete",
  );
}
