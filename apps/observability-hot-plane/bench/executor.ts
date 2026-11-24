import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClickHouseExecutor } from "../src/clickhouse.ts";
import { BENCH_DIR, BENCH_PASSWORDS } from "./settings.ts";

/** The bench container's administrator over the same TLS HTTP client the hot plane uses. */
export function adminExecutor() {
  return createClickHouseExecutor({
    ca: readFileSync(join(BENCH_DIR, "certs/ca.pem"), "utf8"),
    host: "localhost",
    password: BENCH_PASSWORDS.admin_password,
    username: "default",
  });
}
