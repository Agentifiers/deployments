import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelGatewayServiceConfiguration, readBifrostVirtualKey } from "./config.ts";
import { TRUSTED_KEY_ARN } from "./test-support.ts";

const PREVIOUS_KEY_ARN =
  "arn:aws:kms:us-east-2:111122223333:key/99999999-8888-7777-6666-555555555555";
const environment = {
  MODEL_GATEWAY_BIFROST_URL: "http://127.0.0.1:8081",
  MODEL_GATEWAY_BIFROST_VIRTUAL_KEY_FILE: "/run/model-gateway/bifrost-virtual-key",
  MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS: ` ${TRUSTED_KEY_ARN}, ${PREVIOUS_KEY_ARN},${TRUSTED_KEY_ARN}`,
  PORT: "8080",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("model gateway configuration", () => {
  test("parses the environment contract", () => {
    expect(modelGatewayServiceConfiguration(environment)).toEqual({
      bifrostUrl: "http://127.0.0.1:8081",
      bifrostVirtualKeyFile: "/run/model-gateway/bifrost-virtual-key",
      defaultModelSpendCeiling: "unlimited",
      port: 8080,
      trustedSigningKeyArns: [TRUSTED_KEY_ARN, PREVIOUS_KEY_ARN],
    });
  });

  test("reads the install's default operator-funded spend ceiling", () => {
    expect(
      modelGatewayServiceConfiguration({
        ...environment,
        DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "5000000",
      }).defaultModelSpendCeiling,
    ).toEqual({ monthlyUsdMicros: 5_000_000 });
    expect(() =>
      modelGatewayServiceConfiguration({
        ...environment,
        DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "5 USD",
      }),
    ).toThrow(
      "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS must be a whole number of USD micros.",
    );
  });

  test("rejects missing values, aliases, and non-origin Bifrost URLs", () => {
    for (const override of [
      { MODEL_GATEWAY_BIFROST_URL: "" },
      { MODEL_GATEWAY_BIFROST_URL: "https://bifrost.example.com" },
      { MODEL_GATEWAY_BIFROST_URL: "http://127.0.0.1:8081/v1" },
      { MODEL_GATEWAY_BIFROST_VIRTUAL_KEY_FILE: " " },
      { MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS: "," },
      { MODEL_GATEWAY_TRUSTED_SIGNING_KEY_ARNS: "alias/model-gateway-token" },
      { PORT: "70000" },
    ]) {
      expect(() => modelGatewayServiceConfiguration({ ...environment, ...override })).toThrow();
    }
  });

  test("reads the organization key store only when the dedicated key is configured", () => {
    const keyArn = "arn:aws:kms:us-east-2:111122223333:key/22222222-3333-4444-5555-666666666666";
    expect(
      modelGatewayServiceConfiguration({
        ...environment,
        DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN: keyArn,
        DEPLOYMENTS_AI_STAGE: "dev",
      }).organizationKeys,
    ).toEqual({ kmsKeyArn: keyArn, stage: "dev" });
    expect(modelGatewayServiceConfiguration(environment)).not.toHaveProperty("organizationKeys");
    for (const override of [
      { DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN: keyArn },
      {
        DEPLOYMENTS_AI_MODEL_CREDENTIAL_KMS_KEY_ARN: "alias/platform-model-credentials",
        DEPLOYMENTS_AI_STAGE: "dev",
      },
    ]) {
      expect(() => modelGatewayServiceConfiguration({ ...environment, ...override })).toThrow();
    }
  });

  test("reads the trimmed internal key and fails fast when it is missing or empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-gateway-config-"));
    directories.push(dir);
    const path = join(dir, "bifrost-virtual-key");
    expect(readBifrostVirtualKey(path)).rejects.toThrow("unreadable");
    await writeFile(path, "  \n");
    expect(readBifrostVirtualKey(path)).rejects.toThrow("empty");
    await writeFile(path, "sk-bf-abc\n");
    expect(await readBifrostVirtualKey(path)).toBe("sk-bf-abc");
  });
});
