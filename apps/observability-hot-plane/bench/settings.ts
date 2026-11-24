import { tmpdir } from "node:os";
import { join } from "node:path";

export const BENCH_DIR = process.env.BENCH_DIR ?? join(tmpdir(), "observability-hot-plane-bench");
export const CLICKHOUSE_CONTAINER = "observability-hot-plane-bench";
export const API_CONTAINER = "observability-hot-plane-bench-api";
export const API_PORT = 3910;
export const SERVICE_TOKEN = "bench-service-token";

/** Throwaway credentials for the disposable bench container. */
export const BENCH_PASSWORDS = {
  admin_password: "bench-admin",
  ingest_password: "bench-ingest",
  query_password: "bench-query",
} as const;

export const ORGANIZATIONS = 50;
export const organizationId = (index: number) => `01BENCHORG${String(index).padStart(16, "0")}`;
export const PROJECT_ID = "01BENCHPROJECT000000000000";
/** Each organization has a busy environment (index 0) and a quiet one (index 1). */
export const environmentId = (organization: number, index: number) =>
  `01BENCHENV${String(organization).padStart(14, "0")}${index}0`;
