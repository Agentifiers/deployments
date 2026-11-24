import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeKmsEnvelopeAdapter,
  makeModelGatewayRunLeaseReader,
  makeOrganizationModelKeyResolver,
  readOperatorFundedModelSpend,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { modelGatewayServiceConfiguration, readBifrostVirtualKey } from "./config.ts";
import { createModelGatewayHandler, MAX_REQUEST_BODY_BYTES } from "./gateway.ts";
import { makeOperatorSpendCheck } from "./operator-spend.ts";
import { makeRunActivityCheck } from "./run-activity.ts";
import { kmsPublicKeyFetcher, makeTrustedPublicKeys } from "./signing-keys.ts";

/** Streamed completions may pause between chunks while a model thinks; Bun's ceiling is 255 s. */
const SOCKET_IDLE_TIMEOUT_SECONDS = 255;

export async function startModelGateway(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = modelGatewayServiceConfiguration(environment);
  const internalVirtualKey = await readBifrostVirtualKey(configuration.bifrostVirtualKeyFile);
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(environment),
  );
  const kms = new KMSClient({});
  const { organizationKeys } = configuration;
  const server = Bun.serve({
    fetch: createModelGatewayHandler({
      bifrostUrl: configuration.bifrostUrl,
      internalVirtualKey,
      log: (entry) => console.log(JSON.stringify(entry)),
      now: Date.now,
      operatorSpend: makeOperatorSpendCheck({
        now: Date.now,
        read: (organizationId, asOf) =>
          readOperatorFundedModelSpend(database, organizationId, {
            asOf,
            defaultCeiling: configuration.defaultModelSpendCeiling,
          }),
      }),
      organizationKeys:
        organizationKeys &&
        makeOrganizationModelKeyResolver({
          database,
          envelope: makeKmsEnvelopeAdapter({
            keyId: organizationKeys.kmsKeyArn,
            kms,
            stage: organizationKeys.stage,
          }),
        }),
      publicKey: makeTrustedPublicKeys(
        configuration.trustedSigningKeyArns,
        kmsPublicKeyFetcher(kms),
      ),
      requestId: randomUUID,
      runActivity: makeRunActivityCheck({
        now: Date.now,
        reader: makeModelGatewayRunLeaseReader(database),
      }),
    }),
    hostname: "0.0.0.0",
    idleTimeout: SOCKET_IDLE_TIMEOUT_SECONDS,
    // The handler enforces the 32 MiB limit with an OpenAI-shaped 413; Bun's cap only backstops it.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES * 2,
    port: configuration.port,
  });
  // The load balancer drains the task before SIGTERM; let in-flight completions finish.
  const stop = () => void server.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(
    JSON.stringify({ event: "model_gateway.listening", level: "info", port: server.port }),
  );
  return { server, stop };
}

if (import.meta.main) {
  startModelGateway().catch((cause: unknown) => {
    console.error(
      JSON.stringify({
        event: "model_gateway.start_failed",
        level: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    process.exitCode = 1;
  });
}
