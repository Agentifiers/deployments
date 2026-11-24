import { type TransactionOperation, workerPersistence } from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { AgentRunWorkerRecordError } from "./records.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

function releaseThreadExecutionLease(lease: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression: "#data.#owner = :owner AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#owner": "owner",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":owner": lease.data.owner,
      ":version": lease.data.version,
    },
    kind: "delete",
    record: lease,
  };
}

export function releaseStaleThreadExecutionLease(
  lease: RuntimeLeaseRecordValue,
): TransactionOperation {
  const runCondition = lease.data.runId
    ? " AND #data.#runId = :runId"
    : " AND attribute_not_exists(#data.#runId)";
  return {
    conditionExpression: `#data.#owner = :owner AND #data.#expiresAt = :expiresAt AND #data.#version = :version${runCondition}`,
    expressionAttributeNames: {
      "#data": "data",
      "#expiresAt": "expiresAt",
      "#owner": "owner",
      "#runId": "runId",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":expiresAt": lease.data.expiresAt,
      ":owner": lease.data.owner,
      ...(lease.data.runId ? { ":runId": lease.data.runId } : {}),
      ":version": lease.data.version,
    },
    kind: "delete",
    record: lease,
  };
}

export function requireThreadExecutionLease(lease: RuntimeLeaseRecordValue): TransactionOperation {
  return {
    conditionExpression:
      "#data.#owner = :owner AND #data.#runId = :runId AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#owner": "owner",
      "#runId": "runId",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":owner": lease.data.owner,
      ":runId": lease.data.runId,
      ":version": lease.data.version,
    },
    key: { pk: lease.pk, sk: lease.sk },
    kind: "condition-check",
    table: "execution",
  };
}

async function currentThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  lease: RuntimeLeaseRecordValue,
): Promise<RuntimeLeaseRecordValue | undefined> {
  const found = await workerPersistence.read(
    dependencies.database,
    "execution",
    { pk: lease.pk, sk: lease.sk },
    true,
  );
  if (found === undefined) return undefined;
  if (found.itemType !== "runtime-lease") {
    throw new AgentRunWorkerRecordError(
      "thread_execution_lease_invalid",
      "Thread execution lease key contains an unexpected record.",
    );
  }
  return found;
}

export async function releaseExactThreadExecutionLease(
  dependencies: AgentRunWorkerDependencies,
  lease: RuntimeLeaseRecordValue,
): Promise<void> {
  const operation = releaseThreadExecutionLease(lease);
  const transactionToken = createHash("sha256")
    .update(JSON.stringify(operation))
    .digest("hex")
    .slice(0, 36);
  try {
    await workerPersistence.commit(dependencies.database, [operation], transactionToken);
  } catch (cause) {
    try {
      const latest = await currentThreadExecutionLease(dependencies, lease);
      if (
        !latest ||
        latest.data.owner !== lease.data.owner ||
        latest.data.runId !== lease.data.runId ||
        latest.data.version !== lease.data.version
      ) {
        return;
      }
    } catch (reconciliationCause) {
      throw new AggregateError(
        [cause, reconciliationCause],
        "Thread execution publication barrier release could not be reconciled.",
      );
    }
    throw cause;
  }
}
