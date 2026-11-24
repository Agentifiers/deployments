import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The public email worker's Lambda environment, as `platform-identity` sets it: the database
 * tables, the email key, and the stage, and nothing else. Read from the module so a new
 * requirement on the worker fails here before it fails at Lambda init on a stack.
 */
function workerEnvironmentNames() {
  const module = readFileSync(
    new URL("../../../infrastructure/modules/platform-identity/main.tf", import.meta.url),
    "utf8",
  );
  const worker = module.slice(
    module.indexOf('resource "aws_lambda_function" "public_email_worker"'),
  );
  const variables = worker.slice(worker.indexOf("variables = merge("), worker.indexOf("tags"));
  const database = module.slice(module.indexOf("database_environment = {"));
  const databaseBlock = database.slice(0, database.indexOf("}"));
  return [...`${databaseBlock}\n${variables}`.matchAll(/(DEPLOYMENTS_AI_[A-Z_]+)\s+=/gu)].map(
    (match) => match[1]!,
  );
}

const names = workerEnvironmentNames();
const previous = Object.fromEntries(
  [...names, "DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID"].map((name) => [
    name,
    process.env[name],
  ]),
);

beforeAll(() => {
  for (const name of names) process.env[name] = name.endsWith("STAGE") ? "dev" : `test-${name}`;
  delete process.env.DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID;
});

afterAll(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("the public email worker starts with only the environment its Lambda is given", async () => {
  expect(names).toContain("DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID");
  expect(names).not.toContain("DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID");

  const { handler } = await import("./public-email-worker.ts");

  expect(typeof handler).toBe("function");
});
