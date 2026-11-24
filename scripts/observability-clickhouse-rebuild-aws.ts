/* eslint-disable no-await-in-loop -- AWS waiters and result pages are ordered. */
import { checked, command, json } from "./observability-clickhouse-rebuild-support.ts";

export interface HotOutputs {
  readonly backup_bucket: string;
  readonly checkpoint_table: string;
  readonly cluster_arn: string;
  readonly instance_id: string;
  readonly service_name: string;
}

export async function namedQuery(queryId: string) {
  const response = json<{ NamedQuery?: { QueryString?: string } }>(
    await checked("aws", [
      "athena",
      "get-named-query",
      "--named-query-id",
      queryId,
      "--output",
      "json",
    ]),
    "Athena get-named-query",
  );
  const query = response.NamedQuery?.QueryString?.trim().replace(/;$/u, "");
  if (!query) throw new Error(`Athena named query ${queryId} has no SQL.`);
  return query;
}

export async function startAthena(workgroup: string, query: string) {
  const response = json<{ QueryExecutionId?: string }>(
    await checked("aws", [
      "athena",
      "start-query-execution",
      "--work-group",
      workgroup,
      "--query-string",
      query,
      "--output",
      "json",
    ]),
    "Athena start-query-execution",
  );
  if (!response.QueryExecutionId) throw new Error("Athena did not return a query execution ID.");
  return response.QueryExecutionId;
}

export async function waitForAthena(queryExecutionId: string, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const response = json<{
      QueryExecution?: {
        Status?: { State?: string; StateChangeReason?: string };
      };
    }>(
      await checked("aws", [
        "athena",
        "get-query-execution",
        "--query-execution-id",
        queryExecutionId,
        "--output",
        "json",
      ]),
      "Athena get-query-execution",
    );
    const status = response.QueryExecution?.Status;
    if (status?.State === "SUCCEEDED") return;
    if (status?.State === "FAILED" || status?.State === "CANCELLED") {
      throw new Error(
        `Athena ${status.State.toLowerCase()}: ${status.StateChangeReason ?? "unknown"}`,
      );
    }
    await Bun.sleep(2_000);
  }
  await checked("aws", [
    "athena",
    "stop-query-execution",
    "--query-execution-id",
    queryExecutionId,
  ]);
  throw new Error(
    `Athena query did not finish within ${timeoutSeconds} seconds and was cancelled.`,
  );
}

export async function athenaResultRows(queryExecutionId: string) {
  const rows: string[][] = [];
  let nextToken: string | undefined;
  do {
    const response = json<{
      NextToken?: string;
      ResultSet?: {
        Rows?: readonly { Data?: readonly { VarCharValue?: string }[] }[];
      };
    }>(
      await checked("aws", [
        "athena",
        "get-query-results",
        "--query-execution-id",
        queryExecutionId,
        "--output",
        "json",
        ...(nextToken ? ["--next-token", nextToken] : []),
      ]),
      "Athena get-query-results",
    );
    rows.push(
      ...(response.ResultSet?.Rows ?? []).map((row) =>
        (row.Data ?? []).map((column) => column.VarCharValue ?? ""),
      ),
    );
    nextToken = response.NextToken;
  } while (nextToken);
  return rows;
}

export function reconciliationSucceeded(rows: readonly (readonly string[])[]) {
  const header = rows[0];
  const reconciledIndex = header?.indexOf("reconciled") ?? -1;
  if (reconciledIndex < 0) throw new Error("Reconciliation results have no reconciled column.");
  return rows.slice(1).every((row) => row[reconciledIndex]?.toLowerCase() === "true");
}

export async function stopService(hot: HotOutputs) {
  await checked("aws", [
    "ecs",
    "update-service",
    "--cluster",
    hot.cluster_arn,
    "--service",
    hot.service_name,
    "--desired-count",
    "0",
    "--output",
    "json",
  ]);
  await checked("aws", [
    "ecs",
    "wait",
    "services-stable",
    "--cluster",
    hot.cluster_arn,
    "--services",
    hot.service_name,
  ]);
}

export async function startService(hot: HotOutputs) {
  await checked("aws", [
    "ecs",
    "update-service",
    "--cluster",
    hot.cluster_arn,
    "--service",
    hot.service_name,
    "--desired-count",
    "1",
    "--force-new-deployment",
    "--output",
    "json",
  ]);
  await checked("aws", [
    "ecs",
    "wait",
    "services-stable",
    "--cluster",
    hot.cluster_arn,
    "--services",
    hot.service_name,
  ]);
}

export async function setEventSourceMappingEnabled(
  uuid: string,
  enabled: boolean,
  timeoutSeconds: number,
) {
  await checked("aws", [
    "lambda",
    "update-event-source-mapping",
    "--uuid",
    uuid,
    enabled ? "--enabled" : "--no-enabled",
    "--output",
    "json",
  ]);
  const expected = enabled ? "Enabled" : "Disabled";
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    const mapping = await eventSourceMappingState(uuid);
    if (mapping.State === expected) return;
    if (mapping.State === "Failed") {
      throw new Error(
        `Projector event-source mapping failed: ${mapping.StateTransitionReason ?? "unknown"}`,
      );
    }
    await Bun.sleep(2_000);
  }
  throw new Error(
    `Projector event-source mapping did not become ${expected.toLowerCase()} in time.`,
  );
}

export async function eventSourceMappingState(uuid: string) {
  return json<{ State?: string; StateTransitionReason?: string }>(
    await checked("aws", [
      "lambda",
      "get-event-source-mapping",
      "--uuid",
      uuid,
      "--output",
      "json",
    ]),
    "Lambda event-source mapping",
  );
}

export async function ssmCommand(instanceId: string, commands: readonly string[], timeout = 3600) {
  const response = json<{ Command?: { CommandId?: string } }>(
    await checked("aws", [
      "ssm",
      "send-command",
      "--document-name",
      "AWS-RunShellScript",
      "--instance-ids",
      instanceId,
      "--timeout-seconds",
      String(timeout),
      "--parameters",
      JSON.stringify({ commands, executionTimeout: [String(timeout)] }),
      "--output",
      "json",
    ]),
    "SSM send-command",
  );
  const commandId = response.Command?.CommandId;
  if (!commandId) throw new Error("SSM did not return a command ID.");
  for (let attempt = 0; attempt < timeout / 2; attempt += 1) {
    const invocation = await command("aws", [
      "ssm",
      "get-command-invocation",
      "--command-id",
      commandId,
      "--instance-id",
      instanceId,
      "--output",
      "json",
    ]);
    if (invocation.code !== 0 && invocation.stderr.includes("InvocationDoesNotExist")) {
      await Bun.sleep(2_000);
      continue;
    }
    if (invocation.code !== 0) throw new Error(invocation.stderr.trim());
    const value = json<{
      StandardErrorContent?: string;
      StandardOutputContent?: string;
      Status?: string;
    }>(invocation.stdout, "SSM get-command-invocation");
    if (value.Status === "Success") return value.StandardOutputContent ?? "";
    if (["Cancelled", "Failed", "TimedOut", "Cancelling"].includes(value.Status ?? "")) {
      throw new Error(
        `SSM rebuild command ${value.Status}: ${value.StandardErrorContent ?? "unknown"}`,
      );
    }
    await Bun.sleep(2_000);
  }
  await checked("aws", ["ssm", "cancel-command", "--command-id", commandId]);
  throw new Error("SSM command did not finish before its timeout.");
}

/**
 * SSM runs commands as root without HOME, so clickhouse-client cannot find the admin client
 * configuration the node bootstrap writes; name it explicitly.
 */
export const CLICKHOUSE_ADMIN_CLIENT =
  "clickhouse-client --config-file /root/.clickhouse-client/config.xml";

export function bashSsmCommand(commands: readonly string[]) {
  const script = ["set -euo pipefail", ...commands, ""].join("\n");
  const encoded = Buffer.from(script).toString("base64");
  return `printf '%s' '${encoded}' | base64 --decode | /usr/bin/env bash`;
}

export async function assertProjectionFailureFencesClear(
  backupBucket: string,
  failureQueueUrls: Readonly<Record<string, string>>,
) {
  const backup = json<{ KeyCount?: number }>(
    await checked("aws", [
      "s3api",
      "list-objects-v2",
      "--bucket",
      backupBucket,
      "--max-keys",
      "1",
      "--output",
      "json",
    ]),
    "Firehose failed-delivery bucket listing",
  );
  if ((backup.KeyCount ?? 0) > 0) {
    throw new Error("The observability Firehose failed-delivery bucket is not empty.");
  }
  for (const [consumer, queueUrl] of Object.entries(failureQueueUrls)) {
    const queue = json<{
      Attributes?: Readonly<Record<string, string>>;
    }>(
      await checked("aws", [
        "sqs",
        "get-queue-attributes",
        "--queue-url",
        queueUrl,
        "--attribute-names",
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesDelayed",
        "ApproximateNumberOfMessagesNotVisible",
        "--output",
        "json",
      ]),
      `Observability ${consumer} failure queue`,
    );
    const pending = Object.values(queue.Attributes ?? {}).reduce(
      (total, value) => total + Number.parseInt(value, 10),
      0,
    );
    if (!Number.isSafeInteger(pending) || pending > 0) {
      throw new Error(`The observability ${consumer} failure queue is not empty.`);
    }
  }
}
