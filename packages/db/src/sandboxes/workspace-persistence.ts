import { Effect, Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { RecordDecodeError, withCanonicalRecordKeys } from "../records/index.ts";
import {
  SandboxLeaseRecord,
  SandboxWorkspaceRecord,
  type SandboxExecutionTargetKind,
} from "../records/sandboxes.ts";

export type SandboxWorkspaceRecordValue = typeof SandboxWorkspaceRecord.Type;
export type SandboxWorkspaceData = SandboxWorkspaceRecordValue["data"];
type SandboxLeaseRecordValue = typeof SandboxLeaseRecord.Type;

export interface SandboxWorkspaceKey {
  readonly executionTargetId: string;
  readonly executionTargetKind: SandboxExecutionTargetKind;
  readonly organizationId: string;
  readonly threadId: string;
}

export interface SandboxLeaseKey {
  readonly executionTargetId: string;
  readonly executionTargetKind: SandboxExecutionTargetKind;
  readonly leaseId: string;
  readonly organizationId: string;
}

/**
 * Durable `/workspace` state for one (thread, execution target) pair. Every write is a full,
 * versioned put: `create` is create-only and `update` replaces exactly the decoded previous
 * version, so a concurrent writer surfaces as a write conflict (`isDatabaseWriteConflict`).
 */
export interface SandboxWorkspacePersistence {
  readonly create: (
    data: Omit<SandboxWorkspaceData, "version">,
  ) => Promise<SandboxWorkspaceRecordValue>;
  readonly load: (key: SandboxWorkspaceKey) => Promise<SandboxWorkspaceRecordValue | undefined>;
  readonly loadLease: (key: SandboxLeaseKey) => Promise<SandboxLeaseRecordValue | undefined>;
  readonly update: (
    previous: SandboxWorkspaceRecordValue,
    data: Omit<SandboxWorkspaceData, "version">,
  ) => Promise<SandboxWorkspaceRecordValue>;
}

function workspaceRecord(data: Omit<SandboxWorkspaceData, "version">, version: number) {
  return Effect.try({
    catch: (cause) =>
      new RecordDecodeError({ cause, message: "Sandbox workspace keys cannot be derived." }),
    try: () =>
      withCanonicalRecordKeys({
        data: {
          ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
          version,
        },
        itemType: "sandbox-workspace" as const,
      }),
  }).pipe(
    Effect.flatMap((record) =>
      Schema.decodeUnknownEffect(SandboxWorkspaceRecord, { onExcessProperty: "error" })(record),
    ),
    Effect.mapError((cause) =>
      cause instanceof RecordDecodeError
        ? cause
        : new RecordDecodeError({ cause, message: "Sandbox workspace record is invalid." }),
    ),
  );
}

export function makeSandboxWorkspacePersistence(
  database: DynamoDatabaseService,
): SandboxWorkspacePersistence {
  return {
    async create(data) {
      const record = await Effect.runPromise(workspaceRecord(data, 0));
      await database.transactWrite([{ kind: "put", record }]);
      return record;
    },
    async load(workspace) {
      const record = await database.getRecord(
        "execution",
        {
          pk: key("ORG", workspace.organizationId, "THREAD", workspace.threadId),
          sk: key("SANDBOX-WORKSPACE", workspace.executionTargetKind, workspace.executionTargetId),
        },
        true,
      );
      if (!record || record.itemType === "sandbox-workspace") return record;
      throw new RecordDecodeError({
        cause: record.itemType,
        message: "Sandbox workspace key contains an unexpected record.",
      });
    },
    async loadLease(lease) {
      const record = await database.getRecord(
        "execution",
        {
          pk: key(
            "ORG",
            lease.organizationId,
            "EXECUTION-TARGET",
            lease.executionTargetKind,
            lease.executionTargetId,
          ),
          sk: key("SANDBOX-LEASE", lease.leaseId),
        },
        true,
      );
      if (!record || record.itemType === "sandbox-lease") return record;
      throw new RecordDecodeError({
        cause: record.itemType,
        message: "Sandbox lease key contains an unexpected record.",
      });
    },
    async update(previous, data) {
      const record = await Effect.runPromise(workspaceRecord(data, previous.data.version + 1));
      await database.transactWrite([{ kind: "put", previousRecord: previous, record }]);
      return record;
    },
  };
}
