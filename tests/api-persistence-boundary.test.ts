import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const apiPackage = JSON.parse(readFileSync("functions/api/package.json", "utf8")) as {
  readonly dependencies: Readonly<Record<string, string>>;
};
const dbPackage = JSON.parse(readFileSync("packages/db/package.json", "utf8")) as {
  readonly dependencies: Readonly<Record<string, string>>;
};

describe("API persistence boundary", () => {
  test("keeps durable API persistence in the DB package", () => {
    expect(existsSync("functions/api/src/dynamo-tenancy-service.ts")).toBe(false);
    expect(existsSync("functions/api/src/dynamo-agent-service.ts")).toBe(false);
    expect(existsSync("functions/api/src/dynamo-idempotency.ts")).toBe(false);
    expect(existsSync("packages/db/src/dynamo-tenancy-service.ts")).toBe(false);
    expect(existsSync("packages/db/src/dynamo-agent-service.ts")).toBe(false);
    expect(existsSync("packages/db/src/tenancy-persistence.ts")).toBe(false);
    expect(existsSync("packages/db/src/agent-lifecycle-persistence.ts")).toBe(false);
    expect(existsSync("packages/db/src/tenancy.ts")).toBe(true);
    expect(existsSync("packages/db/src/agent-lifecycle.ts")).toBe(true);
    expect(existsSync("packages/db/src/idempotency.ts")).toBe(true);
    expect(existsSync("packages/db/src/idempotency-kms.ts")).toBe(true);
    expect(existsSync("packages/db/src/records/tenancy.ts")).toBe(true);
    expect(existsSync("packages/db/src/persistence-types.ts")).toBe(true);
    expect(existsSync("packages/db/src/persistence-contract.ts")).toBe(false);
    expect(apiPackage.dependencies).not.toHaveProperty("@deployments-ai/events");
    expect(apiPackage.dependencies).not.toHaveProperty("@deployments-ai/agent-manifest");
    expect(apiPackage.dependencies).toHaveProperty("@deployments-ai/api-contract");
    expect(dbPackage.dependencies).not.toHaveProperty("@deployments-ai/api-contract");
  });
});
