import { createHash } from "node:crypto";
import { makeIdGenerator, type DynamoDatabaseService, type Ulid } from "@deployments-ai/db";
import type { BrainModelUsageScope } from "@deployments-ai/brains";
import {
  makeModelUsageRecorder,
  type ModelUsageRecorderService,
} from "@deployments-ai/model-usage";
import type { ModelUsageLedgerEntry } from "@deployments-ai/model-gateway";
import { Effect } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicBrainRunId(...parts: readonly string[]): Ulid {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0, 16);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded as Ulid;
}

export type BrainModelUsageRecorder = (input: {
  readonly entry: ModelUsageLedgerEntry;
  readonly operationId: Ulid;
  readonly operationType: string;
  readonly scope: BrainModelUsageScope;
}) => Promise<void>;

export function brainModelUsageRecorder(
  database: DynamoDatabaseService,
  recorder: ModelUsageRecorderService = makeModelUsageRecorder(database, makeIdGenerator()),
): BrainModelUsageRecorder {
  return async ({ entry, operationId, operationType, scope }) => {
    await Effect.runPromise(
      recorder.record(entry, {
        environmentId: scope.environmentId as Ulid,
        operationId,
        operationType,
        organizationId: scope.organizationId as Ulid,
        projectId: scope.projectId as Ulid,
        workspaceId: scope.workspaceId as Ulid | undefined,
      }),
    );
  };
}
