/**
 * Serves the hot-plane query API against the bench ClickHouse as the observability_query user,
 * the way the ECS task does, without the Kinesis writer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHotPlaneApi } from "../src/api.ts";
import { createClickHouseExecutor } from "../src/clickhouse.ts";
import { API_PORT, BENCH_DIR, BENCH_PASSWORDS, SERVICE_TOKEN } from "./settings.ts";

Bun.serve({
  fetch: createHotPlaneApi({
    clickhouse: createClickHouseExecutor({
      ca: readFileSync(join(BENCH_DIR, "certs/ca.pem"), "utf8"),
      host: "localhost",
      password: BENCH_PASSWORDS.query_password,
      username: "observability_query",
    }),
    organizationErasure: {
      erase: () => Promise.reject(new Error("The bench does not erase organizations.")),
    },
    serviceToken: SERVICE_TOKEN,
  }).fetch,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  port: API_PORT,
});
console.log(`Hot-plane API listening on http://127.0.0.1:${API_PORT}.`);
