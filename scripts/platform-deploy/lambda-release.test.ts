import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  governanceTenantDirectoryRecord,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeterministicZip,
  deploymentArtifacts,
  type DeploymentArtifactName,
} from "../build-deployment-artifacts.ts";
import { switchGovernanceInventoryShardWrites } from "./governance-inventory-shards-migration.ts";
import {
  buildReleaseVariables,
  contentAddressedArtifactKey,
  verifyStoredArtifact,
} from "./lambda-artifacts.ts";
import {
  artifactFunctionSuffixes,
  deployedLambdaFunctionName,
  deployLambdaRelease,
  lambdaReleaseOptions,
} from "./lambda-release.ts";
import { type CommandRunner, runCommand } from "./process.ts";
import { sha256File, type VerifiedRelease } from "./release-bundle.ts";

describe("Lambda artifact deployment names", () => {
  it("uses canonical unprefixed agent-runtime names", () => {
    expect(deployedLambdaFunctionName("agent-runtime", "agent-runtime-api")).toBe(
      "agent-runtime-api",
    );
  });

  it("uses account-local names for platform runtimes", () => {
    expect(deployedLambdaFunctionName("agent-email-runtime", "agent-email-api")).toBe(
      "agent-email-api",
    );
  });

  it("builds and targets every platform identity Lambda", () => {
    expect(deploymentArtifacts["identity-api"].files).toEqual([
      "functions/identity-api/dist/lambda-main.js",
      "functions/identity-api/dist/principal-status.js",
      "functions/identity-api/dist/public-email-worker.js",
      "functions/identity-api/package.json",
    ]);
    expect(deploymentArtifacts["identity-email-worker"].files).toHaveLength(4);
    expect(deployedLambdaFunctionName("identity-api", "api")).toBe("identity-api");
    expect(deployedLambdaFunctionName("identity-api", "public-email-worker")).toBe(
      "identity-public-email-worker",
    );
    expect(deployedLambdaFunctionName("identity-api", "principal-status")).toBe(
      "identity-principal-status",
    );
    expect(deployedLambdaFunctionName("identity-email-worker", "email-reconciler")).toBe(
      "identity-email-reconciler",
    );
  });

  it("builds and targets every portable memory runtime Lambda", () => {
    expect(deploymentArtifacts["memory-runtime"].files).toEqual(
      expect.arrayContaining([
        "functions/memory-runtime/dist/erasure-worker.js",
        "functions/memory-runtime/dist/index-dispatcher.js",
        "functions/memory-runtime/dist/operation-reconciler.js",
        "functions/memory-runtime/dist/operation-worker.js",
      ]),
    );
    for (const suffix of [
      "memory-erasure",
      "memory-index-dispatch",
      "memory-operation",
      "memory-operation-reconcile",
    ]) {
      expect(deployedLambdaFunctionName("memory-runtime", suffix)).toBe(suffix);
    }
  });

  it("builds and targets the Brain erasure worker", () => {
    expect(deploymentArtifacts["platform-api"].files).toContain(
      "functions/api/dist/brain-erasure-main.js",
    );
    expect(artifactFunctionSuffixes["platform-api"]).toContain("brain-erasure-worker");
    expect(deployedLambdaFunctionName("platform-api", "brain-erasure-worker")).toBe(
      "brain-erasure-worker",
    );
  });

  it("releases code to the default search placement Lambdas, whose code OpenTofu ignores", () => {
    expect(deploymentArtifacts["memory-runtime"].files).toContain(
      "functions/memory-runtime/dist/search-placement-worker.js",
    );
    expect(artifactFunctionSuffixes["memory-runtime"]).toContain("memory-search-placement");
    expect(deploymentArtifacts["platform-api"].files).toContain(
      "functions/api/dist/brain-search-placement-main.js",
    );
    expect(artifactFunctionSuffixes["platform-api"]).toContain("brain-search-placement");
  });

  it("targets the inbound command Lambda through the channel runtime artifact", () => {
    expect(artifactFunctionSuffixes["channel-provider-runtime"]).toContain("channel-command");
    expect(artifactFunctionSuffixes["channel-provider-runtime"]).toContain("channel-ingress-flush");
  });

  it("updates the evaluation worker Lambda from the agent runtime artifact", () => {
    expect(deploymentArtifacts["agent-runtime"].files).toContain(
      "functions/runtime-api/dist/evaluation-worker-main.mjs",
    );
    expect(artifactFunctionSuffixes["agent-runtime"]).toContain("agent-runtime-evaluation-worker");
  });

  it("packages and targets the console server Lambda", () => {
    expect(deploymentArtifacts.console).toEqual({
      buildPackage: "@deployments-ai/console",
      directory: "apps/console/.output/server",
    });
    expect(Object.keys(deploymentArtifacts)).toHaveLength(14);
    expect(artifactFunctionSuffixes.console).toEqual(["console"]);
    expect(deployedLambdaFunctionName("console", "console")).toBe("console");
  });

  it("packages and targets the apps database Lambda", () => {
    expect(deploymentArtifacts["apps-database"]).toEqual({
      buildPackage: "@deployments-ai/apps-database",
      directory: "functions/apps-database/dist",
    });
    expect(artifactFunctionSuffixes["apps-database"]).toEqual(["apps-database"]);
    expect(deployedLambdaFunctionName("apps-database", "apps-database")).toBe("apps-database");
  });

  it("packages and targets the event analytics projector Lambda", () => {
    expect(deploymentArtifacts["event-analytics-projector"]).toEqual({
      buildPackage: "@deployments-ai/event-analytics-projector",
      files: ["functions/event-analytics-projector/dist/index.mjs"],
    });
    expect(artifactFunctionSuffixes["event-analytics-projector"]).toEqual([
      "event-analytics-projector",
    ]);
    expect(
      deployedLambdaFunctionName("event-analytics-projector", "event-analytics-projector"),
    ).toBe("event-analytics-projector");
  });

  it("packages and targets the app domain reconciler Lambda", () => {
    expect(deploymentArtifacts["app-domains"]).toEqual({
      buildPackage: "@deployments-ai/app-domains",
      files: ["functions/app-domains/dist/index.mjs"],
    });
    expect(artifactFunctionSuffixes["app-domains"]).toEqual(["apps-domains"]);
    expect(deployedLambdaFunctionName("app-domains", "apps-domains")).toBe("apps-domains");
  });

  it("derives stable content-addressed artifact references", () => {
    const digest = "a".repeat(64);
    expect(contentAddressedArtifactKey("platform-api", digest)).toBe(
      `releases/sha256/${digest}/platform-api.zip`,
    );
    expect(() => contentAddressedArtifactKey("platform-api", "invalid")).toThrow("Invalid SHA-256");
  });

  it("builds OpenTofu variables from immutable artifact versions", () => {
    const artifacts = Object.fromEntries(
      Object.keys(deploymentArtifacts).map((name) => [
        name,
        { key: `${name}/digest.zip`, version: `${name}-version` },
      ]),
    ) as Parameters<typeof buildReleaseVariables>[1];
    expect(buildReleaseVariables("artifact-bucket", artifacts)).toMatchObject({
      agent_runtime_artifact_bucket: "artifact-bucket",
      agent_runtime_artifact_key: "agent-runtime/digest.zip",
      agent_runtime_artifact_version: "agent-runtime-version",
      platform_identity_enabled: true,
    });
    expect(buildReleaseVariables("artifact-bucket", artifacts)).toMatchObject({
      console_artifact_bucket: "artifact-bucket",
      console_artifact_key: "console/digest.zip",
      console_artifact_version: "console-version",
    });
    expect(buildReleaseVariables("artifact-bucket", artifacts)).toMatchObject({
      ops_alerts_notifier_artifact_bucket: "artifact-bucket",
      ops_alerts_notifier_artifact_key: "ops-alerts-notifier/digest.zip",
      ops_alerts_notifier_artifact_version: "ops-alerts-notifier-version",
      document_extraction_artifact_bucket: "artifact-bucket",
      document_extraction_artifact_key: "document-extraction/digest.zip",
      document_extraction_artifact_version: "document-extraction-version",
      apps_database_artifact_bucket: "artifact-bucket",
      apps_database_artifact_key: "apps-database/digest.zip",
      apps_database_artifact_version: "apps-database-version",
      event_analytics_projector_artifact_bucket: "artifact-bucket",
      event_analytics_projector_artifact_key: "event-analytics-projector/digest.zip",
      event_analytics_projector_artifact_version: "event-analytics-projector-version",
      app_domains_artifact_bucket: "artifact-bucket",
      app_domains_artifact_key: "app-domains/digest.zip",
      app_domains_artifact_version: "app-domains-version",
    });
  });

  it("skips only Lambda groups whose OpenTofu outputs are absent", () => {
    expect(
      lambdaReleaseOptions(
        {
          agent_email: { api_function_arn: "arn:api", inbound_function_arn: "arn:inbound" },
          agent_observability: { fact_stream_arn: "" },
          platform_identity_function_arns: null,
        },
        false,
      ),
    ).toEqual({
      allowMissing: false,
      allowMissingAgentEmail: false,
      allowMissingAgentObservability: true,
      allowMissingAppDomains: true,
      allowMissingAppsDatabase: true,
      allowMissingConsole: true,
      allowMissingEventAnalytics: true,
      allowMissingIdentity: true,
    });
    expect(
      lambdaReleaseOptions(
        {
          agent_email: { api_function_arn: "arn:api", inbound_function_arn: "arn:inbound" },
          console_url: "https://app.example.com",
        },
        false,
      ).allowMissingConsole,
    ).toBe(false);
    expect(lambdaReleaseOptions({ app_runtime: null }, false)).toMatchObject({
      allowMissingAppDomains: true,
      allowMissingAppsDatabase: true,
    });
    expect(
      lambdaReleaseOptions(
        {
          app_runtime: {
            database_function_name: "apps-database",
            domain_reconciler_function_name: "apps-domains",
          },
        },
        false,
      ),
    ).toMatchObject({ allowMissingAppDomains: false, allowMissingAppsDatabase: false });
    expect(
      lambdaReleaseOptions({ app_runtime: { database_function_name: "apps-database" } }, false),
    ).toMatchObject({ allowMissingAppDomains: true, allowMissingAppsDatabase: false });
    expect(
      lambdaReleaseOptions(
        {
          event_analytics_projector_function_arn:
            "arn:aws:lambda:us-east-2:123456789012:function:event-analytics-projector",
        },
        false,
      ).allowMissingEventAnalytics,
    ).toBe(false);
    expect(
      lambdaReleaseOptions({ event_analytics_projector_function_arn: null }, false)
        .allowMissingEventAnalytics,
    ).toBe(true);
    expect(lambdaReleaseOptions({ agent_email: { api_function_arn: "arn:api" } }, true)).toEqual({
      allowMissing: true,
      allowMissingAgentEmail: true,
      allowMissingAgentObservability: true,
      allowMissingAppDomains: true,
      allowMissingAppsDatabase: true,
      allowMissingConsole: true,
      allowMissingEventAnalytics: true,
      allowMissingIdentity: true,
    });
  });

  it("rejects a stored artifact that violates its immutable content address", () => {
    const digest = "b".repeat(64);
    const expected = {
      checksum: Buffer.from(digest, "hex").toString("base64"),
      kmsKeyArn: "arn:aws:kms:us-east-2:123456789012:key/example",
      sha256: digest,
      size: 42,
    };
    expect(
      verifyStoredArtifact(
        {
          ChecksumSHA256: expected.checksum,
          ContentLength: expected.size,
          Metadata: { sha256: digest },
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: expected.kmsKeyArn,
          VersionId: "version-id",
        },
        expected,
      ),
    ).toBe("version-id");
    expect(() =>
      verifyStoredArtifact(
        {
          ChecksumSHA256: "wrong",
          ContentLength: expected.size,
          Metadata: { sha256: digest },
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: expected.kmsKeyArn,
          VersionId: "version-id",
        },
        expected,
      ),
    ).toThrow("checksum");
  });
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function artifactArchive(files: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "lambda-artifact-"));
  directories.push(directory);
  const staging = join(directory, "staging");
  await mkdir(staging);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(staging, name), content);
  }
  const path = join(directory, "artifact.zip");
  await createDeterministicZip(staging, path);
  return { path, sha256: await sha256File(path) };
}

interface DeployedFunction {
  readonly CodeSha256: string;
  readonly FunctionName: string;
  readonly Handler: string;
  readonly LastModified?: string;
  readonly Timeout?: number;
}

/** Lambda's default timeout, for fixtures that leave it out. */
const DEFAULT_TIMEOUT_SECONDS = 3;
const RELEASED_AT = 1_798_761_600_000;

function fakeLambda(deployed: readonly DeployedFunction[], now = () => RELEASED_AT) {
  const published: DeployedFunction[] = [];
  const entries: Record<string, readonly string[]> = {};
  const run: CommandRunner = async (command) => {
    if (command.includes("list-functions")) {
      return JSON.stringify(
        deployed.map((entry) => ({
          LastModified: "2026-01-01T00:00:00.000+0000",
          Timeout: DEFAULT_TIMEOUT_SECONDS,
          ...entry,
        })),
      );
    }
    if (command.includes("update-function-code")) {
      const functionName = command[command.indexOf("--function-name") + 1]!;
      const archive = command[command.indexOf("--zip-file") + 1]!.slice("fileb://".length);
      entries[functionName] = (await runCommand(["unzip", "-Z1", archive]))
        .trim()
        .split("\n")
        .toSorted();
      const current = deployed.find((entry) => entry.FunctionName === functionName)!;
      published.push({
        ...current,
        CodeSha256: Buffer.from(await sha256File(archive), "hex").toString("base64"),
        LastModified: new Date(now()).toISOString().replace("Z", "+0000"),
      });
    }
    return "";
  };
  return { entries, published, run };
}

function releaseLambdas(
  artifacts: Partial<Record<DeploymentArtifactName, { path: string; sha256: string }>>,
  run: CommandRunner,
  now = () => RELEASED_AT,
) {
  return deployLambdaRelease({
    allowMissing: true,
    allowMissingAgentEmail: true,
    allowMissingAgentObservability: true,
    allowMissingAppDomains: true,
    allowMissingAppsDatabase: true,
    allowMissingConsole: true,
    allowMissingEventAnalytics: true,
    allowMissingIdentity: true,
    dryRun: false,
    name: "test",
    now,
    release: { artifacts } as unknown as VerifiedRelease,
    run,
  });
}

describe("Lambda code release", () => {
  it("publishes each function only its own handler module and the artifact package.json", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "api", Handler: "lambda-main.handler" },
      {
        CodeSha256: "stale",
        FunctionName: "governance-worker",
        Handler: "governance-worker-main.handler",
      },
      {
        CodeSha256: "stale",
        FunctionName: "agent-runtime-webhook-events",
        Handler: "webhook-event-handler.handler",
      },
      { CodeSha256: "stale", FunctionName: "console", Handler: "index.handler" },
    ]);
    const { functions: released } = await releaseLambdas(
      {
        "agent-runtime": await artifactArchive({
          "run-dispatch.mjs": "export const handler = () => 'dispatch';\n",
          "webhook-event-handler.mjs": "export const handler = () => 'webhook';\n",
        }),
        console: await artifactArchive({
          "index.mjs": "export { handler } from './server.mjs';\n",
          "server.mjs": "export const handler = () => 'console';\n",
        }),
        "platform-api": await artifactArchive({
          "governance-worker-main.js": "export const handler = () => 'governance';\n",
          "lambda-main.js": "export const handler = () => 'tenancy';\n",
          "package.json": '{ "type": "module" }\n',
        }),
      },
      lambda.run,
    );

    expect(lambda.entries).toEqual({
      "agent-runtime-webhook-events": ["webhook-event-handler.mjs"],
      api: ["lambda-main.js", "package.json"],
      console: ["index.mjs", "server.mjs"],
      "governance-worker": ["governance-worker-main.js", "package.json"],
    });
    expect(
      released
        .map(({ codeSha256, functionName }) => ({
          CodeSha256: Buffer.from(codeSha256, "hex").toString("base64"),
          functionName,
        }))
        .toSorted((left, right) => left.functionName.localeCompare(right.functionName)),
    ).toEqual(
      lambda.published
        .map(({ CodeSha256, FunctionName }) => ({ CodeSha256, functionName: FunctionName }))
        .toSorted((left, right) => left.functionName.localeCompare(right.functionName)),
    );
  });

  it("leaves a function untouched when only a sibling entry of its artifact changed", async () => {
    const tenancy = "export const handler = () => 'tenancy';\n";
    const first = fakeLambda([
      { CodeSha256: "stale", FunctionName: "api", Handler: "lambda-main.handler" },
      {
        CodeSha256: "stale",
        FunctionName: "governance-worker",
        Handler: "governance-worker-main.handler",
      },
    ]);
    await releaseLambdas(
      {
        "platform-api": await artifactArchive({
          "governance-worker-main.js": "export const handler = () => 'governance v1';\n",
          "lambda-main.js": tenancy,
          "package.json": '{ "type": "module" }\n',
        }),
      },
      first.run,
    );

    const second = fakeLambda(first.published);
    await releaseLambdas(
      {
        "platform-api": await artifactArchive({
          "governance-worker-main.js": "export const handler = () => 'governance v2';\n",
          "lambda-main.js": tenancy,
          "package.json": '{ "type": "module" }\n',
        }),
      },
      second.run,
    );

    expect(second.published.map((deployed) => deployed.FunctionName)).toEqual([
      "governance-worker",
    ]);
  });

  it("reports when replaced code stops running, counting the updates an earlier run made", async () => {
    const deployed = fakeLambda([
      { CodeSha256: "stale", FunctionName: "api", Handler: "lambda-main.handler", Timeout: 900 },
      {
        CodeSha256: "stale",
        FunctionName: "governance-worker",
        Handler: "governance-worker-main.handler",
        Timeout: 120,
      },
      {
        CodeSha256: "stale",
        FunctionName: "api-brain",
        Handler: "brain-main.handler",
        Timeout: 29,
      },
    ]);
    const platformApi = (version: string) =>
      artifactArchive({
        "brain-main.js": `export const handler = () => 'brain ${version}';\n`,
        "governance-worker-main.js": `export const handler = () => 'governance ${version}';\n`,
        "lambda-main.js": "export const handler = () => 'tenancy';\n",
        "package.json": '{ "type": "module" }\n',
      });
    const initial = await releaseLambdas({ "platform-api": await platformApi("v1") }, deployed.run);
    const anHourLater = RELEASED_AT + 3_600_000;
    const afterInitial = fakeLambda(deployed.published, () => anHourLater);
    const workers = await releaseLambdas(
      { "platform-api": await platformApi("v2") },
      afterInitial.run,
      () => anHourLater,
    );
    const afterWorkers = fakeLambda(
      deployed.published.map(
        (current) =>
          afterInitial.published.find(
            ({ FunctionName }) => FunctionName === current.FunctionName,
          ) ?? current,
      ),
    );
    const repeat = await releaseLambdas(
      { "platform-api": await platformApi("v2") },
      afterWorkers.run,
      () => anHourLater + 100_000,
    );

    expect([initial, workers, repeat].map(({ replacedCodeEndsAt }) => replacedCodeEndsAt)).toEqual([
      1_798_762_500_000, 1_798_765_320_000, 1_798_765_680_000,
    ]);
    expect(afterWorkers.published).toEqual([]);
  });

  it("makes a rerun wait for code an earlier run replaced before an old legacy-only listing ends", async () => {
    const organizationId = "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A";
    const legacyPartition = `ORG#${organizationId}#GOVERNANCE-INVENTORY`;
    const fake = fakeDynamoDocumentClient();
    for (let index = 0; index < 150; index += 1) {
      const record = withCanonicalRecordKeys({
        data: {
          count: 1,
          expiresAt: "2027-01-01T00:00:00.000Z",
          limitKey: `legacy.${String(index).padStart(3, "0")}`,
          organizationId,
          scopeId: organizationId,
          version: 1,
          window: "2026-10-01T00",
        },
        itemType: "rate-limit-counter" as const,
        ttl: Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1_000),
      }) as unknown as PlatformRecord;
      fake.put(DEFAULT_TABLE_NAMES.usage, record);
      fake.put(DEFAULT_TABLE_NAMES.control, {
        ...governanceTenantDirectoryRecord(record)!,
        pk: legacyPartition,
      });
    }
    const legacyOnlyPage = (exclusiveStartKey?: Record<string, unknown>) =>
      fake.client.send(
        new QueryCommand({
          ConsistentRead: true,
          ExclusiveStartKey: exclusiveStartKey,
          ExpressionAttributeValues: { ":pk": legacyPartition },
          KeyConditionExpression: "pk = :pk",
          Limit: 100,
          TableName: DEFAULT_TABLE_NAMES.control,
        }),
      );
    const platformApi = await artifactArchive({
      "lambda-main.js": "export const handler = () => 'tenancy';\n",
      "package.json": '{ "type": "module" }\n',
    });
    const replaced = fakeLambda([
      { CodeSha256: "stale", FunctionName: "api", Handler: "lambda-main.handler", Timeout: 900 },
    ]);
    await releaseLambdas({ "platform-api": platformApi }, replaced.run);

    const oldPageOne = await legacyOnlyPage();
    const oldSnapshot = [...(oldPageOne.Items ?? [])];
    const oldPageTwoAt = RELEASED_AT + 899_000;
    let oldPageTwoRead = false;
    const readOldPageTwo = async () => {
      oldSnapshot.push(...((await legacyOnlyPage(oldPageOne.LastEvaluatedKey)).Items ?? []));
      oldPageTwoRead = true;
    };

    const rerun = await releaseLambdas(
      { "platform-api": platformApi },
      fakeLambda(replaced.published).run,
      () => RELEASED_AT + 120_000,
    );
    if (oldPageTwoAt <= rerun.replacedCodeEndsAt) await readOldPageTwo();
    await switchGovernanceInventoryShardWrites({
      client: fake.client,
      tableNames: DEFAULT_TABLE_NAMES,
    });
    const store = makeDynamoGovernanceStore(fake.client, DEFAULT_TABLE_NAMES);
    let listed = 0;
    let cursor: string | undefined;
    do {
      const page = await store.listTenantRecords(organizationId, cursor);
      listed += page.items.length;
      cursor = page.cursor;
    } while (cursor);
    if (!oldPageTwoRead) await readOldPageTwo();

    expect({
      listed,
      oldSnapshot: oldSnapshot.length,
      replacedCodeEndsAt: rerun.replacedCodeEndsAt,
    }).toEqual({ listed: 150, oldSnapshot: 150, replacedCodeEndsAt: 1_798_762_860_000 });
  });

  it("publishes the ops alerts notifier bundle to its index handler", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "ops-alerts-notifier", Handler: "index.handler" },
    ]);

    const { functions: released } = await releaseLambdas(
      {
        "ops-alerts-notifier": await artifactArchive({
          "index.mjs": "export const handler = () => 'ops alerts';\n",
        }),
      },
      lambda.run,
    );

    expect(lambda.entries).toEqual({ "ops-alerts-notifier": ["index.mjs"] });
    expect(released.map(({ artifact, functionName }) => ({ artifact, functionName }))).toEqual([
      { artifact: "ops-alerts-notifier", functionName: "ops-alerts-notifier" },
    ]);
  });

  it("publishes the whole document extraction archive so the supervisor finds its child entry", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "document-extraction", Handler: "handler.handler" },
    ]);
    await releaseLambdas(
      {
        "document-extraction": await artifactArchive({
          "child.mjs": "export {};\n",
          "handler.mjs": "export const handler = () => 'supervisor';\n",
        }),
      },
      lambda.run,
    );

    expect(lambda.entries).toEqual({ "document-extraction": ["child.mjs", "handler.mjs"] });
  });

  it("publishes the whole apps database archive so the handler finds its WebAssembly parser", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "apps-database", Handler: "index.handler" },
    ]);
    const { functions: released } = await releaseLambdas(
      {
        "apps-database": await artifactArchive({
          "index.mjs": "export const handler = () => 'apps database';\n",
          "libpg-query.wasm": "wasm\n",
        }),
      },
      lambda.run,
    );

    expect(lambda.entries).toEqual({ "apps-database": ["index.mjs", "libpg-query.wasm"] });
    expect(released.map(({ artifact, functionName }) => ({ artifact, functionName }))).toEqual([
      { artifact: "apps-database", functionName: "apps-database" },
    ]);
  });

  it("publishes the app domain reconciler bundle to the apps-domains Lambda", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "apps-domains", Handler: "index.handler" },
    ]);
    const { functions: released } = await releaseLambdas(
      {
        "app-domains": await artifactArchive({
          "index.mjs": "export const handler = () => 'app domains';\n",
        }),
      },
      lambda.run,
    );

    expect(lambda.entries).toEqual({ "apps-domains": ["index.mjs"] });
    expect(released.map(({ artifact, functionName }) => ({ artifact, functionName }))).toEqual([
      { artifact: "app-domains", functionName: "apps-domains" },
    ]);
  });

  it("fails when a function's handler names no module in its artifact", async () => {
    const lambda = fakeLambda([
      { CodeSha256: "stale", FunctionName: "api", Handler: "observability-api-main.handler" },
    ]);
    const platformApi = await artifactArchive({
      "lambda-main.js": "export const handler = () => 'tenancy';\n",
      "package.json": '{ "type": "module" }\n',
    });

    expect(releaseLambdas({ "platform-api": platformApi }, lambda.run)).rejects.toThrow(
      "Lambda api handler observability-api-main.handler names no module in the platform-api artifact.",
    );
  });
});
