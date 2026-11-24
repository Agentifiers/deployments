import { command, safe } from "./observability-clickhouse-rebuild-support.ts";

/** One rebuild lease per deployment: the hot-plane checkpoint table belongs to one OpenTofu root. */
export const REBUILD_LEASE_KEY = {
  consumer: { S: "observability-clickhouse-rebuild-v1" },
  shard: { S: "full-rebuild" },
} as const;

function leaseFailure(
  operation: string,
  result: { readonly stderr: string; readonly stdout: string },
) {
  return new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function acquireRebuildLease(
  table: string,
  owner: string,
  expiresAtSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  safe(table, "checkpoint table");
  safe(owner, "rebuild lease owner");
  if (
    !Number.isSafeInteger(expiresAtSeconds) ||
    !Number.isSafeInteger(nowSeconds) ||
    expiresAtSeconds <= nowSeconds
  ) {
    throw new Error("Rebuild lease expiry must be a future epoch second.");
  }
  const result = await command("aws", [
    "dynamodb",
    "put-item",
    "--table-name",
    table,
    "--item",
    JSON.stringify({
      ...REBUILD_LEASE_KEY,
      leaseExpiresAt: { N: String(expiresAtSeconds) },
      leaseOwner: { S: owner },
      updatedAt: { S: new Date(nowSeconds * 1_000).toISOString() },
    }),
    "--condition-expression",
    "attribute_not_exists(#leaseOwner) OR #leaseExpiresAt < :now",
    "--expression-attribute-names",
    JSON.stringify({
      "#leaseExpiresAt": "leaseExpiresAt",
      "#leaseOwner": "leaseOwner",
    }),
    "--expression-attribute-values",
    JSON.stringify({ ":now": { N: String(nowSeconds) } }),
  ]);
  if (result.code === 0) return;
  if (result.stderr.includes("ConditionalCheckFailedException")) {
    throw new Error("An observability ClickHouse rebuild already owns the rebuild lease.");
  }
  throw leaseFailure("DynamoDB rebuild lease acquisition", result);
}

export async function releaseRebuildLease(table: string, owner: string) {
  safe(table, "checkpoint table");
  safe(owner, "rebuild lease owner");
  const result = await command("aws", [
    "dynamodb",
    "delete-item",
    "--table-name",
    table,
    "--key",
    JSON.stringify(REBUILD_LEASE_KEY),
    "--condition-expression",
    "#leaseOwner = :owner",
    "--expression-attribute-names",
    JSON.stringify({ "#leaseOwner": "leaseOwner" }),
    "--expression-attribute-values",
    JSON.stringify({ ":owner": { S: owner } }),
  ]);
  if (result.code === 0) return true;
  if (result.stderr.includes("ConditionalCheckFailedException")) return false;
  throw leaseFailure("DynamoDB rebuild lease release", result);
}
