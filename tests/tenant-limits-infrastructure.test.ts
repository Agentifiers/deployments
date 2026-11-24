import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMITTED_RUN_RECEIVE_RESERVE,
  MAX_CONCURRENCY_WAIT_MS,
  MIN_DEFERRAL_SECONDS,
} from "../functions/worker/src/run-capacity-deferral.ts";
import { TENANT_LIMITS_METRIC_NAMESPACE } from "../functions/worker/src/tenant-limit-metrics.ts";
import { TENANT_LIMIT_DEFINITIONS } from "../packages/tenant-limits/src/limits.ts";

const modulesRoot = "infrastructure/modules";

const moduleSource = (childDirectory: string) =>
  readdirSync(join(modulesRoot, childDirectory))
    .filter((fileName) => fileName.endsWith(".tf"))
    .sort()
    .map((fileName) => readFileSync(join(modulesRoot, childDirectory, fileName), "utf8"))
    .join("\n");

const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

const expressionAt = (source: string, start: number) => {
  const open: string[] = [];
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quoted) {
      if (character === "\\") index += 1;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character in closers) open.push(closers[character] ?? "");
    else if (character === open.at(-1)) open.pop();
    else if (character === "\n" && open.length === 0) return source.slice(start, index);
  }
  return source.slice(start);
};

const blockBody = (source: string, header: string) => {
  const start = source.indexOf(`${header} {`);
  return start === -1 ? "" : expressionAt(source, start + header.length + 1).slice(1, -1);
};

const blocksNamed = (source: string, keyword: string) =>
  [...source.matchAll(new RegExp(`^\\s*${keyword} \\{`, "gmu"))].map((match) =>
    expressionAt(source, (match.index ?? 0) + match[0].length - 1).slice(1, -1),
  );

const attribute = (body: string, name: string) => {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*`, "mu").exec(body);
  return match === null ? undefined : expressionAt(body, match.index + match[0].length).trim();
};

const resolveLocals = (source: string, expression: string, seen = new Set<string>()): string =>
  [...expression.matchAll(/\blocal\.(\w+)/gu)].reduce((resolved, [, name = ""]) => {
    if (seen.has(name)) return resolved;
    seen.add(name);
    const definition = blocksNamed(source, "locals")
      .map((locals) => attribute(locals, name))
      .find((candidate) => candidate !== undefined);
    return `${resolved}\n${resolveLocals(source, definition ?? "", seen)}`;
  }, expression);

const grantedActions = (childDirectory: string, policyDocument: string, resource: string) =>
  blocksNamed(
    blockBody(moduleSource(childDirectory), `data "aws_iam_policy_document" "${policyDocument}"`),
    "(?:statement|content)",
  )
    .filter((statement) => attribute(statement, "resources")?.includes(resource))
    .flatMap((statement) => [...(attribute(statement, "actions") ?? "").matchAll(/"([^"]+)"/gu)])
    .map(([, action = ""]) => action)
    .sort();

const gatewayIntegrationUris = [
  ...readFileSync(join(modulesRoot, "platform-api/gateway.tf"), "utf8").matchAll(
    /^resource "aws_apigatewayv2_integration" "\w+" \{[\s\S]*?^\s*integration_uri\s*=\s*(\S+)$/gmu,
  ),
]
  .map(([, uri = ""]) => uri)
  .sort();

const gatewayLambdas = {
  "each.value.invoke_arn": {
    childDirectory: "platform-api",
    functionName: "api",
    role: "aws_iam_role.lambda.arn",
    policyDocument: "lambda",
  },
  "var.agent_email_api_invoke_arn": {
    childDirectory: "agent-email",
    functionName: "api",
    role: 'aws_iam_role.runtime["api"].arn',
    policyDocument: "api_runtime",
  },
  "var.memory_api_invoke_arn": {
    childDirectory: "memory-runtime",
    functionName: "runtime",
    role: "aws_iam_role.runtime[each.key].arn",
    policyDocument: "runtime",
  },
  "var.runtime_api_invoke_arn": {
    childDirectory: "agent-runtime",
    functionName: "api",
    role: "aws_iam_role.worker.arn",
    policyDocument: "worker",
  },
} as const;

const gatewayRuntimeModules = ["platform_api", "agent_email", "memory_runtime", "agent_runtime"];

describe("tenant limit infrastructure", () => {
  test("covers every Lambda the unified gateway integrates", () => {
    expect(gatewayIntegrationUris).toEqual(Object.keys(gatewayLambdas).sort());
  });

  test("every gateway Lambda reads organization limits and may admit requests", () => {
    const wiring = Object.values(gatewayLambdas).map(
      ({ childDirectory, functionName, role, policyDocument }) => {
        const source = moduleSource(childDirectory);
        const lambda = blockBody(source, `resource "aws_lambda_function" "${functionName}"`);
        const environment = resolveLocals(
          source,
          attribute(blockBody(lambda, "environment"), "variables") ?? "",
        );
        return {
          lambda: `${childDirectory}:${functionName}`,
          role: attribute(lambda, "role") === role,
          admissionTable: attribute(environment, "DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE"),
          tenantLimitDefaults: attribute(environment, "DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS"),
          admissionGrant: grantedActions(
            childDirectory,
            policyDocument,
            "var.request_admission_table_arn",
          ),
        };
      },
    );
    expect(wiring).toEqual(
      ["platform-api:api", "agent-email:api", "memory-runtime:runtime", "agent-runtime:api"].map(
        (lambda) => ({
          lambda,
          role: true,
          admissionTable: "var.request_admission_table_name",
          tenantLimitDefaults: "var.tenant_limit_defaults_json",
          admissionGrant: ["dynamodb:UpdateItem"],
        }),
      ),
    );
  });

  test("the platform hands the admission table and limit defaults to every gateway runtime", () => {
    const platformSource = moduleSource("platform");
    expect(
      gatewayRuntimeModules.map((moduleName) => {
        const call = blockBody(platformSource, `module "${moduleName}"`);
        return {
          moduleName,
          tableArn: attribute(call, "request_admission_table_arn"),
          tableName: attribute(call, "request_admission_table_name"),
          defaults: attribute(call, "tenant_limit_defaults_json"),
        };
      }),
    ).toEqual(
      gatewayRuntimeModules.map((moduleName) => ({
        moduleName,
        tableArn: "module.platform_data.request_admission_table_arn",
        tableName: "module.platform_data.request_admission_table_name",
        defaults: "jsonencode(var.operations.tenant_limit_defaults)",
      })),
    );
  });

  test("the platform validates limit defaults against the bounds the runtimes enforce", () => {
    const conditionBound = String.raw`tenant_limit_defaults\.(\w+),\s*min\s*=\s*(\d+),\s*max\s*=\s*(\d+)`;
    const validation =
      blocksNamed(moduleSource("platform"), "validation").find((block) =>
        new RegExp(conditionBound, "u").test(block),
      ) ?? "";
    const [condition, errorMessage] = [
      [attribute(validation, "condition"), conditionBound],
      [attribute(validation, "error_message"), String.raw`(\w+) (\d+)-(\d+)`],
    ].map(([text = "", pattern = ""]) =>
      Object.fromEntries(
        [...text.matchAll(new RegExp(pattern, "gu"))].map(([, key, minimum, maximum]) => [
          key,
          { maximum: Number(maximum), minimum: Number(minimum) },
        ]),
      ),
    );
    const enforced = Object.fromEntries(
      Object.values(TENANT_LIMIT_DEFINITIONS).map(({ environmentKey, maximum, minimum }) => [
        environmentKey,
        { maximum, minimum },
      ]),
    );
    expect({ condition, errorMessage }).toEqual({ condition: enforced, errorMessage: enforced });
  });

  test("the agent worker task and the Lambdas sharing its environment read limit defaults", () => {
    const source = moduleSource("agent-runtime");
    expect(
      ["agent_worker_container_environment", "workflow_queue_environment"].map((name) =>
        attribute(resolveLocals(source, `local.${name}`), "DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS"),
      ),
    ).toEqual(["var.tenant_limit_defaults_json", "var.tenant_limit_defaults_json"]);
  });

  test("the agent run queue keeps a deferred run through its wait, and the worker reads its limit", () => {
    const agentRuntime = moduleSource("agent-runtime");
    const redriveLocal = attribute(
      blockBody(agentRuntime, 'resource "aws_sqs_queue" "runs"'),
      "maxReceiveCount",
    )?.replace(/^local\./u, "");
    const deployedMaxReceiveCount = Number(
      blocksNamed(agentRuntime, "locals")
        .map((locals) => attribute(locals, redriveLocal ?? ""))
        .find((definition) => definition !== undefined),
    );
    const localMaxReceiveCount = Number(
      attribute(
        blockBody(readFileSync("infrastructure/environments/local/main.tf", "utf8"), "agent-run ="),
        "max_receive_count",
      ),
    );
    const receiveBudget =
      Math.ceil(MAX_CONCURRENCY_WAIT_MS / 1000 / MIN_DEFERRAL_SECONDS) +
      ADMITTED_RUN_RECEIVE_RESERVE;
    expect({
      deployed: deployedMaxReceiveCount >= receiveBudget,
      local: localMaxReceiveCount >= receiveBudget,
      workerReads: attribute(
        resolveLocals(agentRuntime, "local.agent_worker_container_environment"),
        "DEPLOYMENTS_AI_AGENT_RUN_MAX_RECEIVE_COUNT",
      ),
    }).toEqual({
      deployed: true,
      local: true,
      workerReads: `tostring(local.${redriveLocal})`,
    });
  });

  test("the request admission table is a bare keyed counter with no stream, index, or recovery", () => {
    const admissionTables = [
      blockBody(moduleSource("platform-data"), 'resource "aws_dynamodb_table" "request_admission"'),
      blockBody(
        readFileSync("infrastructure/environments/local/main.tf", "utf8"),
        'resource "aws_dynamodb_table" "request_admission"',
      ),
    ];
    expect(
      admissionTables.map((table) => ({
        name: attribute(table, "name"),
        billingMode: attribute(table, "billing_mode"),
        hashKey: attribute(table, "hash_key"),
        rangeKey: attribute(table, "range_key"),
        streamEnabled: attribute(table, "stream_enabled"),
        globalSecondaryIndexes: blocksNamed(
          table,
          '(?:dynamic "global_secondary_index"|global_secondary_index)',
        ).length,
        ttlAttribute: attribute(blockBody(table, "ttl"), "attribute_name"),
        pointInTimeRecovery: attribute(blockBody(table, "point_in_time_recovery"), "enabled"),
      })),
    ).toEqual(
      ["false", undefined].map((pointInTimeRecovery) => ({
        name: '"request-admission"',
        billingMode: '"PAY_PER_REQUEST"',
        hashKey: '"pk"',
        rangeKey: undefined,
        streamEnabled: undefined,
        globalSecondaryIndexes: 0,
        ttlAttribute: '"ttl"',
        pointInTimeRecovery,
      })),
    );
  });

  test("runtimes may only increment the request admission table", () => {
    const childDirectories = readdirSync(modulesRoot).sort();
    expect(
      childDirectories.flatMap((childDirectory) =>
        blocksNamed(moduleSource(childDirectory), "(?:statement|content)")
          .filter((statement) => statement.includes("request_admission_table_arn"))
          .map((statement) => `${childDirectory}: ${attribute(statement, "actions")}`),
      ),
    ).toEqual([
      'agent-email: ["dynamodb:UpdateItem"]',
      'agent-runtime: ["dynamodb:UpdateItem"]',
      'memory-runtime: ["dynamodb:UpdateItem"]',
      'platform-api: ["dynamodb:UpdateItem"]',
    ]);
    expect(
      childDirectories.flatMap((childDirectory) =>
        moduleSource(childDirectory)
          .split("\n")
          .filter((line) => line.includes("var.request_admission_table_arn"))
          .map((line) => `${childDirectory}: ${line.trim().replaceAll(/\s+/gu, " ")}`),
      ),
    ).toEqual([
      "agent-email: resources = [var.request_admission_table_arn]",
      "agent-runtime: resources = [var.request_admission_table_arn]",
      "memory-runtime: resources = [var.request_admission_table_arn]",
      "platform-api: resources = [var.request_admission_table_arn]",
    ]);
  });

  test("alarms when the limiter fails open or a run waits out its concurrency bound", () => {
    const alarms = readdirSync(modulesRoot)
      .sort()
      .flatMap((childDirectory) => {
        const source = moduleSource(childDirectory);
        return [...source.matchAll(/^resource "aws_cloudwatch_metric_alarm" "\w+" \{/gmu)]
          .map((match) => expressionAt(source, (match.index ?? 0) + match[0].length - 1))
          .filter((alarm) =>
            ['"LimiterUnavailable"', '"RunConcurrencyWaitExpired"'].includes(
              attribute(alarm, "metric_name") ?? "",
            ),
          )
          .map((alarm) => {
            const namespace = attribute(alarm, "namespace") ?? "";
            return {
              module: childDirectory,
              metric: attribute(alarm, "metric_name"),
              namespace: JSON.parse(
                namespace.startsWith("local.")
                  ? (blocksNamed(source, "locals")
                      .map((locals) => attribute(locals, namespace.slice("local.".length)))
                      .find((definition) => definition !== undefined) ?? "null")
                  : namespace,
              ),
              statistic: attribute(alarm, "statistic"),
              period: attribute(alarm, "period"),
              threshold: attribute(alarm, "threshold"),
              comparison: attribute(alarm, "comparison_operator"),
              dimensions: attribute(alarm, "dimensions"),
            };
          });
      });
    // tenant-limits.mdx: every expired run wait is a failed run, so that alarm fires on the
    // first one; a single fail-open admission is designed, so the limiter alarm needs five.
    expect(alarms).toEqual(
      (
        [
          ["agent-runtime", "RunConcurrencyWaitExpired", "0", '"GreaterThanThreshold"'],
          ["platform-api", "LimiterUnavailable", "5", '"GreaterThanOrEqualToThreshold"'],
        ] as const
      ).map(([module, metric, threshold, comparison]) => ({
        module,
        metric: `"${metric}"`,
        namespace: TENANT_LIMITS_METRIC_NAMESPACE,
        statistic: '"Sum"',
        period: "300",
        threshold,
        comparison,
        dimensions: undefined,
      })),
    );
  });
});
