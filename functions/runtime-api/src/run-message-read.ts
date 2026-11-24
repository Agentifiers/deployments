import { Ulid, makeRunMessagePersistence, type PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import { RuntimeApiError } from "./runtime-api-error.ts";
import {
  assertRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

export async function loadRun(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  threadId: Ulid,
  runId: Ulid,
) {
  const persistence = makeRunMessagePersistence(dependencies.database);
  const lookup = assertRecord(
    await persistence.getRunLookup({
      organizationId: principal.scope.organizationId,
      runId,
      threadId,
    }),
    "run-lookup",
    "Run",
  );
  return scoped(
    assertRecord(
      await persistence.getRun({
        idempotencyKey: lookup.data.idempotencyKey,
        organizationId: principal.scope.organizationId,
        threadId,
      }),
      "run",
      "Run",
    ),
    principal,
  );
}

export async function loadFinalizedRunMessage(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  run: Extract<PlatformRecord, { readonly itemType: "run" }>,
) {
  if (run.data.status !== "completed") {
    throw new RuntimeApiError(409, "run_not_completed", "Run has not completed.");
  }
  const persistence = makeRunMessagePersistence(dependencies.database);
  const timelineEvents = await persistence.getCompletionEvents({
    organizationId: run.data.organizationId,
    runId: run.data.id,
    sequence: run.data.version,
  });
  const matches = timelineEvents.filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: "timeline-event" }> =>
      record.itemType === "timeline-event" &&
      record.data.eventType === "run.completed" &&
      record.data.runId === run.data.id &&
      record.data.threadId === run.data.threadId &&
      record.data.sequence === run.data.version,
  );
  if (matches.length !== 1) {
    throw new RuntimeApiError(
      409,
      "run_message_unavailable",
      "Completed run message reference is unavailable.",
    );
  }
  const timelineData = matches[0]!.data.data;
  let messageId: Ulid;
  try {
    messageId = Schema.decodeUnknownSync(Ulid)(timelineData?.messageId);
  } catch {
    throw new RuntimeApiError(
      409,
      "run_message_unavailable",
      "Completed run message reference is unavailable.",
    );
  }
  const messageSequence = timelineData?.messageSequence;
  if (!Number.isSafeInteger(messageSequence) || Number(messageSequence) < 0) {
    throw new RuntimeApiError(
      409,
      "run_message_unavailable",
      "Completed run message sequence is unavailable.",
    );
  }
  const message = scoped(
    assertRecord(
      await persistence.getMessage({
        messageId,
        organizationId: run.data.organizationId,
        sequence: Number(messageSequence),
        threadId: run.data.threadId,
      }),
      "message",
      "Run message",
    ),
    principal,
  );
  if (
    message.data.id !== messageId ||
    message.data.runId !== run.data.id ||
    message.data.threadId !== run.data.threadId ||
    message.data.sequence !== messageSequence ||
    message.data.role !== "assistant"
  ) {
    throw new RuntimeApiError(
      409,
      "run_message_mismatch",
      "Completed run message does not match its canonical reference.",
    );
  }
  return message;
}
