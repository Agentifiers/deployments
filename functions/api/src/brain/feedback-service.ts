import type { RecordBrainFeedbackRequest } from "@deployments-ai/api-contract";
import {
  apiPersistence,
  key,
  PersistenceError,
  recordTtlPassed,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import type { BrainApiInvocation, BrainApiServiceDependencies } from "./service-contracts.ts";

export async function recordBrainFeedback(input: {
  readonly dependencies: BrainApiServiceDependencies;
  readonly invocation: BrainApiInvocation;
  readonly now: () => string;
  readonly queryAttemptId: string;
}) {
  const current = await apiPersistence.read(
    input.dependencies.database,
    "execution",
    {
      pk: key("ORG", input.invocation.organizationId, "QUERY-ATTEMPT", input.queryAttemptId),
      sk: key("BRAIN-QUERY-ATTEMPT", input.queryAttemptId),
    },
    true,
  );
  const recordedAt = input.now();
  if (
    current?.itemType !== "brain-query-attempt" ||
    current.data.organizationId !== input.invocation.organizationId ||
    recordTtlPassed(current, new Date(recordedAt))
  ) {
    throw new PersistenceError(
      "not-found",
      "brain_query_attempt_not_found",
      "The Brain query attempt is unavailable.",
    );
  }
  const body = input.invocation.body as RecordBrainFeedbackRequest;
  const next = withCanonicalRecordKeys({
    ...current,
    data: {
      ...current.data,
      ...(body.feedback ? { feedback: body.feedback } : {}),
      feedbackAt: recordedAt,
      usefulness: body.usefulness,
      version: current.data.version + 1,
    },
  }) as typeof current;
  await apiPersistence.commit(input.dependencies.database, [
    { kind: "put", previousRecord: current, record: next },
  ]);
  return { queryAttemptId: input.queryAttemptId, recordedAt, usefulness: body.usefulness };
}
