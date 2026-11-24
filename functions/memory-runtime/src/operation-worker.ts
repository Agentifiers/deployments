import { Ulid, type DynamoDatabaseService } from "@deployments-ai/db";
import type { makeMemorySearchControlPlane } from "@deployments-ai/memory";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { runtimeMemorySearchControlPlane } from "./operation-control.ts";
import { claimMemorySearchOperation } from "./operation-lease.ts";
import { processQueue, queuePayload, type QueueEventLike } from "./queue.ts";
import { runtimeDatabase } from "./runtime.ts";

type Control = ReturnType<typeof makeMemorySearchControlPlane>;

export async function resumeMemorySearchOperation(args: {
  readonly actionGeneration: number;
  readonly control: Control;
  readonly database: DynamoDatabaseService;
  readonly nextAction: string;
  readonly now: Date;
  readonly operationId: typeof Ulid.Type;
  readonly organizationId: typeof Ulid.Type;
  readonly workerId?: string;
}) {
  const value = await claimMemorySearchOperation({
    actionGeneration: args.actionGeneration,
    database: args.database,
    leaseOwner: args.workerId ?? randomUUID(),
    nextAction: args.nextAction,
    now: args.now,
    operationId: args.operationId,
    organizationId: args.organizationId,
  });
  if (!value) return { stale: true };
  const fence = {
    actionGeneration: value.data.actionGeneration,
    operationId: value.data.id,
  };
  switch (args.nextAction) {
    case "abort-provisioning":
      await args.control.abortProvisioning(args.organizationId, fence);
      break;
    case "provision-components":
      await args.control.prepareProvisioning(
        args.organizationId,
        args.operationId,
        fence.actionGeneration,
      );
      break;
    default:
      throw new Error(`Unknown due memory-search provisioning action: ${args.nextAction}`);
  }
  return { stale: false };
}

export async function handler(event: QueueEventLike) {
  const database = runtimeDatabase();
  const control = await runtimeMemorySearchControlPlane();
  return processQueue(event, async (record) => {
    const payload = queuePayload(record);
    await resumeMemorySearchOperation({
      actionGeneration: Number(payload.actionGeneration),
      control,
      database,
      nextAction: String(payload.nextAction),
      now: new Date(),
      operationId: Schema.decodeUnknownSync(Ulid)(payload.operationId),
      organizationId: Schema.decodeUnknownSync(Ulid)(payload.organizationId),
    });
  });
}
