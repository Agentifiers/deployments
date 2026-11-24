import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { RuntimeLeaseRecord } from "../records/coordination.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";

export type ModelGatewayRunLease = typeof RuntimeLeaseRecord.Type;

export interface ModelGatewayRunLeaseReader {
  /** The thread's execution lease (one consistent GetItem), or undefined when none is held. */
  readonly getThreadExecutionLease: (threadId: string) => Promise<ModelGatewayRunLease | undefined>;
}

const decodeRuntimeLease = Schema.decodeUnknownSync(RuntimeLeaseRecord);

/** Read-only access the model gateway needs to decide whether a run token's run still holds its thread. */
export function makeModelGatewayRunLeaseReader(
  database: DynamoDatabaseService,
): ModelGatewayRunLeaseReader {
  return {
    async getThreadExecutionLease(threadId) {
      const { pk, sk } = withCanonicalRecordKeys({
        data: { id: threadId, leaseKey: `agent-run-thread/${threadId}` },
        itemType: "runtime-lease",
      });
      const found = await database.getRecord("execution", { pk, sk }, true);
      if (found === undefined) return undefined;
      if (found.itemType !== "runtime-lease") {
        throw new Error("Thread execution lease key contains an unexpected record.");
      }
      return decodeRuntimeLease(found);
    },
  };
}
