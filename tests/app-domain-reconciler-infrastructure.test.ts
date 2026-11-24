import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_TAG } from "../functions/app-domains/src/edge.ts";
import { APP_DOMAINS_ENV } from "../functions/app-domains/src/index.ts";
import { tableNamesFromEnvironment } from "../packages/db/src/dynamo-database.ts";
import {
  attribute,
  block,
  blockAt,
  listAttribute,
  readTerraformFiles,
  statements,
} from "./terraform-files.ts";

const appRuntime = readTerraformFiles("infrastructure/modules/app-runtime", "");
const platformApps = readFileSync("infrastructure/modules/platform/apps.tf", "utf8");

function policy(documentName: string) {
  return statements(block(appRuntime, `data "aws_iam_policy_document" "${documentName}"`)).map(
    (statement) => ({
      sid: attribute(statement, "sid"),
      actions: listAttribute(statement, "actions"),
      resources: attribute(statement, "resources"),
      conditions: [...statement.matchAll(/condition \{([\s\S]*?)\n {4}\}/gu)].map((match) => ({
        test: attribute(match[1] ?? "", "test"),
        variable: attribute(match[1] ?? "", "variable"),
        values: listAttribute(match[1] ?? "", "values"),
      })),
    }),
  );
}

test("lets the apps-domains Lambda change and delete only tenants and certificates tagged as its own", () => {
  const managedResource = {
    test: '"StringEquals"',
    variable: `"aws:ResourceTag/${MANAGED_TAG.key}"`,
    values: [MANAGED_TAG.value],
  };
  const managedRequest = [
    {
      test: '"StringEquals"',
      variable: `"aws:RequestTag/${MANAGED_TAG.key}"`,
      values: [MANAGED_TAG.value],
    },
    {
      test: '"ForAllValues:StringEquals"',
      variable: '"aws:TagKeys"',
      values: [MANAGED_TAG.key],
    },
  ];
  const leadingKeys = (values: string[]) => [
    { test: '"ForAllValues:StringLike"', variable: '"dynamodb:LeadingKeys"', values },
  ];
  expect(policy("domain_reconciler")).toEqual([
    {
      sid: '"WriteOwnLogs"',
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: `["\${aws_cloudwatch_log_group.domain_reconciler.arn}:*"]`,
      conditions: [],
    },
    {
      sid: '"GetAppDomainRecords"',
      actions: ["dynamodb:GetItem"],
      resources: "[var.control_table.arn]",
      conditions: leadingKeys(["ORG#*#APP#*", "UNIQUE#app-id"]),
    },
    {
      sid: '"QueryPublishedAppDomains"',
      actions: ["dynamodb:Query"],
      resources: "[var.control_table.arn]",
      conditions: leadingKeys(["UNIQUE#app-hostname"]),
    },
    {
      sid: '"WriteAppDomainRecords"',
      actions: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"],
      resources: "[var.control_table.arn]",
      conditions: leadingKeys([
        "ORG#*#APP#*",
        "ORG#*#GOVERNANCE-INVENTORY",
        "ORG#*#GOVERNANCE-INVENTORY#SHARD#*",
      ]),
    },
    {
      sid: '"ReadGovernanceInventoryLayout"',
      actions: ["dynamodb:GetItem"],
      resources: "[var.control_table.arn]",
      conditions: [
        {
          test: '"ForAllValues:StringEquals"',
          variable: '"dynamodb:LeadingKeys"',
          values: ["GLOBAL#deploy-migration"],
        },
      ],
    },
    {
      sid: '"ReadOrganizationRetentionPolicy"',
      actions: ["dynamodb:GetItem"],
      resources: "[var.control_table.arn]",
      conditions: leadingKeys(["ORG#??????????????????????????"]),
    },
    {
      sid: '"CheckAppDomainWriteConditions"',
      actions: ["dynamodb:ConditionCheckItem"],
      resources: "[var.control_table.arn]",
      conditions: leadingKeys([
        "ORG#*",
        "UNIQUE#app%3A*%3Adomain-hostname",
        "UNIQUE#app%3A*%3Adomain-slot",
        "UNIQUE#app-hostname",
        "UNIQUE#organization%3A*%3Aapp-domain-slot",
      ]),
    },
    {
      sid: '"AppendAppDomainEvents"',
      actions: ["dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"],
      resources: "[var.events_table.arn]",
      conditions: leadingKeys(["ORG#*#AGGREGATE#app-domain#*"]),
    },
    {
      sid: '"SpendCertificateRequestBudgets"',
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:TransactWriteItems"],
      resources: "[var.usage_table.arn]",
      conditions: leadingKeys(["SCOPE#*"]),
    },
    {
      sid: '"ListDistributionTenants"',
      actions: ["cloudfront:ListDistributionTenants"],
      resources: '["*"]',
      conditions: [],
    },
    {
      sid: '"ReadDistributionTenants"',
      actions: [
        "cloudfront:GetDistributionTenant",
        "cloudfront:GetDistributionTenantByDomain",
        "cloudfront:GetManagedCertificateDetails",
        "cloudfront:ListTagsForResource",
      ],
      resources: "[local.distribution_tenants]",
      conditions: [],
    },
    {
      sid: '"CreateManagedTenants"',
      actions: ["cloudfront:CreateDistributionTenant"],
      resources: '["*"]',
      conditions: managedRequest,
    },
    {
      sid: '"TagManagedTenantsOnCreate"',
      actions: ["cloudfront:TagResource"],
      resources: "[local.distribution_tenants]",
      conditions: managedRequest,
    },
    {
      sid: '"ChangeManagedTenants"',
      actions: ["cloudfront:DeleteDistributionTenant", "cloudfront:UpdateDistributionTenant"],
      resources: "[local.distribution_tenants]",
      conditions: [managedResource],
    },
    {
      sid: '"ReadGatewayVpcOrigin"',
      actions: ["cloudfront:GetVpcOrigin"],
      resources: "[aws_cloudfront_vpc_origin.gateway.arn]",
      conditions: [],
    },
    {
      sid: '"ListCertificates"',
      actions: ["acm:ListCertificates"],
      resources: '["*"]',
      conditions: [],
    },
    {
      sid: '"ReadTenantCertificates"',
      actions: ["acm:DescribeCertificate", "acm:ListTagsForCertificate"],
      resources: "[local.tenant_certificates]",
      conditions: [],
    },
    {
      sid: '"RequestTenantCertificates"',
      actions: ["acm:RequestCertificate"],
      resources: '["*"]',
      conditions: [],
    },
    {
      sid: '"TagTenantCertificates"',
      actions: ["acm:AddTagsToCertificate"],
      resources: "[local.tenant_certificates]",
      conditions: managedRequest,
    },
    {
      sid: '"DeleteManagedCertificates"',
      actions: ["acm:DeleteCertificate"],
      resources: "[local.tenant_certificates]",
      conditions: [managedResource],
    },
  ]);
  expect([
    attribute(appRuntime, "distribution_tenants"),
    attribute(appRuntime, "tenant_certificates"),
  ]).toEqual([
    `"arn:\${data.aws_partition.current.partition}:cloudfront::\${data.aws_caller_identity.current.account_id}:distribution-tenant/*"`,
    `"arn:\${data.aws_partition.current.partition}:acm:us-east-1:\${data.aws_caller_identity.current.account_id}:certificate/*"`,
  ]);
  expect(
    attribute(block(appRuntime, 'resource "aws_iam_role_policy" "domain_reconciler"'), "role"),
  ).toBe("aws_iam_role.domain_reconciler.id");
});

test("runs one apps-domains Lambda at a time, outside the VPC, against the custom-domain distribution and the platform tables", () => {
  const lambda = block(appRuntime, 'resource "aws_lambda_function" "domain_reconciler"');
  expect({
    functionName: attribute(lambda, "function_name"),
    handler: attribute(lambda, "handler"),
    ignoreChanges: attribute(lambda, "ignore_changes"),
    logGroup: attribute(
      block(appRuntime, 'resource "aws_cloudwatch_log_group" "domain_reconciler"'),
      "name",
    ),
    memory: attribute(lambda, "memory_size"),
    reservedConcurrency: attribute(lambda, "reserved_concurrent_executions"),
    role: attribute(lambda, "role"),
    runtime: attribute(lambda, "runtime"),
    timeout: attribute(lambda, "timeout"),
    vpc: lambda.includes("vpc_config"),
  }).toEqual({
    functionName: '"apps-domains"',
    handler: '"index.handler"',
    ignoreChanges: "[s3_bucket, s3_key, s3_object_version]",
    logGroup: '"/aws/lambda/apps-domains"',
    memory: "512",
    reservedConcurrency: "1",
    role: "aws_iam_role.domain_reconciler.arn",
    runtime: '"nodejs26.x"',
    timeout: "300",
    vpc: false,
  });
  const environment = Object.fromEntries(
    [
      ...blockAt(lambda, lambda.indexOf("variables = {")).matchAll(/^\s+([A-Z_]+)\s*=\s*(\S+)$/gmu),
    ].map((match) => [match[1], match[2]]),
  );
  expect(environment).toEqual({
    [APP_DOMAINS_ENV.certificateRequestsPerDay]: "var.domain_certificate_requests_per_day",
    [APP_DOMAINS_ENV.certificateRequestsPerOrganizationPerDay]:
      "var.domain_certificate_requests_per_organization_per_day",
    [APP_DOMAINS_ENV.connectionGroupId]: "aws_cloudfront_connection_group.custom_domains.id",
    [APP_DOMAINS_ENV.distributionId]: "aws_cloudfront_multitenant_distribution.custom_domains.id",
    DEPLOYMENTS_AI_CONTROL_TABLE: "var.control_table.name",
    DEPLOYMENTS_AI_EVENTS_TABLE: "var.events_table.name",
    DEPLOYMENTS_AI_USAGE_TABLE: "var.usage_table.name",
  });
  expect(tableNamesFromEnvironment(environment)).toMatchObject({
    control: "var.control_table.name",
    events: "var.events_table.name",
    usage: "var.usage_table.name",
  });
  const objectInput = (name: string) =>
    blockAt(platformApps, platformApps.indexOf(`${name} = {`))
      .split("\n")
      .slice(1, -1)
      .map((line) => line.trim().replace(/\s+=\s+/u, " = "));
  expect({
    artifact: objectInput("domain_reconciler_artifact"),
    events: objectInput("events_table"),
    usage: objectInput("usage_table"),
  }).toEqual({
    artifact: [
      "bucket = var.app_domains_artifact_bucket",
      "key = var.app_domains_artifact_key",
      "version = var.app_domains_artifact_version",
    ],
    events: [
      'arn = module.platform_data.table_arns["events"]',
      'name = module.platform_data.table_names["events"]',
    ],
    usage: [
      'arn = module.platform_data.table_arns["usage"]',
      'name = module.platform_data.table_names["usage"]',
    ],
  });
  const invokeConfig = block(
    appRuntime,
    'resource "aws_lambda_function_event_invoke_config" "domain_reconciler"',
  );
  expect({
    functionName: attribute(invokeConfig, "function_name"),
    maximumEventAge: attribute(invokeConfig, "maximum_event_age_in_seconds"),
    maximumRetries: attribute(invokeConfig, "maximum_retry_attempts"),
  }).toEqual({
    functionName: "aws_lambda_function.domain_reconciler.function_name",
    maximumEventAge: "600",
    maximumRetries: "0",
  });
});

test("budgets 5 certificate requests per organization and 12 for the platform each UTC day by default", () => {
  const limit = (name: string) => {
    const variable = block(appRuntime, `variable "${name}"`);
    return {
      default: attribute(variable, "default"),
      type: attribute(variable, "type"),
      validation: attribute(variable, "condition"),
    };
  };
  expect({
    organization: limit("domain_certificate_requests_per_organization_per_day"),
    platform: limit("domain_certificate_requests_per_day"),
  }).toEqual({
    organization: {
      default: "5",
      type: "number",
      validation:
        "var.domain_certificate_requests_per_organization_per_day >= 1 && floor(var.domain_certificate_requests_per_organization_per_day) == var.domain_certificate_requests_per_organization_per_day",
    },
    platform: {
      default: "12",
      type: "number",
      validation:
        "var.domain_certificate_requests_per_day >= 1 && floor(var.domain_certificate_requests_per_day) == var.domain_certificate_requests_per_day",
    },
  });
});

test("bounds both apps-domains roles with the platform permissions boundary", () => {
  expect(
    ["domain_reconciler", "domain_reconciler_scheduler"].map((role) => {
      const resource = block(appRuntime, `resource "aws_iam_role" "${role}"`);
      return [attribute(resource, "name"), attribute(resource, "permissions_boundary")];
    }),
  ).toEqual([
    ['"apps-domains"', "var.permissions_boundary_arn"],
    ['"apps-domains-scheduler"', "var.permissions_boundary_arn"],
  ]);
});

test("sweeps every 5 minutes and dead-letters a sweep the scheduler cannot deliver", () => {
  const schedule = block(appRuntime, 'resource "aws_scheduler_schedule" "domain_reconciler"');
  expect({
    deadLetter: attribute(blockAt(schedule, schedule.indexOf("dead_letter_config {")), "arn"),
    expression: attribute(schedule, "schedule_expression"),
    input: attribute(schedule, "input"),
    maximumAge: attribute(schedule, "maximum_event_age_in_seconds"),
    mode: attribute(schedule, "mode"),
    retries: attribute(schedule, "maximum_retry_attempts"),
    role: attribute(schedule, "role_arn"),
    target: attribute(schedule, "arn"),
  }).toEqual({
    deadLetter: "aws_sqs_queue.domain_reconciler_schedule_dlq.arn",
    expression: '"rate(5 minutes)"',
    input: 'jsonencode({ kind = "sweep" })',
    maximumAge: "300",
    mode: '"OFF"',
    retries: "2",
    role: "aws_iam_role.domain_reconciler_scheduler.arn",
    target: "aws_lambda_function.domain_reconciler.arn",
  });

  const queue = block(appRuntime, 'resource "aws_sqs_queue" "domain_reconciler_schedule_dlq"');
  expect({
    name: attribute(queue, "name"),
    retention: attribute(queue, "message_retention_seconds"),
    sse: attribute(queue, "sqs_managed_sse_enabled"),
  }).toEqual({ name: '"apps-domains-schedule-dlq"', retention: "1209600", sse: "true" });

  expect(policy("domain_reconciler_scheduler")).toEqual([
    {
      sid: '"InvokeAppsDomains"',
      actions: ["lambda:InvokeFunction"],
      resources: "[aws_lambda_function.domain_reconciler.arn]",
      conditions: [],
    },
    {
      sid: '"DeadLetterUndeliveredSweeps"',
      actions: ["sqs:SendMessage"],
      resources: "[aws_sqs_queue.domain_reconciler_schedule_dlq.arn]",
      conditions: [],
    },
  ]);
  expect(
    attribute(
      block(appRuntime, 'resource "aws_iam_role_policy" "domain_reconciler_scheduler"'),
      "role",
    ),
  ).toBe("aws_iam_role.domain_reconciler_scheduler.id");
  expect(
    listAttribute(
      block(appRuntime, 'data "aws_iam_policy_document" "scheduler_assume"'),
      "identifiers",
    ),
  ).toEqual(["scheduler.amazonaws.com"]);
});

test("alarms on apps-domains errors, dead-lettered sweeps, starved sweeps, and platform certificate budget refusals to the platform alarm topic", () => {
  const alarm = (name: string) => {
    const resource = block(appRuntime, `resource "aws_cloudwatch_metric_alarm" "${name}"`);
    return Object.fromEntries(
      [
        "alarm_actions",
        "comparison_operator",
        "datapoints_to_alarm",
        "evaluation_periods",
        "metric_name",
        "namespace",
        "ok_actions",
        "period",
        "statistic",
        "threshold",
        "treat_missing_data",
        "FunctionName",
        "QueueName",
      ].map((key) => [key, attribute(resource, key)]),
    );
  };
  const notify = {
    alarm_actions: "[var.alarm_topic_arn]",
    comparison_operator: '"GreaterThanThreshold"',
    ok_actions: "[var.alarm_topic_arn]",
    threshold: "0",
    treat_missing_data: '"notBreaching"',
  };
  expect({
    deferredSteps: alarm("domain_reconciler_deferred_steps"),
    errors: alarm("domain_reconciler_errors"),
    platformCertificateBudget: alarm("domain_reconciler_platform_certificate_budget"),
    scheduleDlq: alarm("domain_reconciler_schedule_dlq"),
  }).toEqual({
    deferredSteps: {
      ...notify,
      datapoints_to_alarm: "3",
      evaluation_periods: "3",
      metric_name: '"DeferredReconcileSteps"',
      namespace: '"DeploymentsAI/Apps"',
      period: "300",
      statistic: '"Minimum"',
      FunctionName: undefined,
      QueueName: undefined,
    },
    platformCertificateBudget: {
      ...notify,
      datapoints_to_alarm: undefined,
      evaluation_periods: "1",
      metric_name: '"PlatformCertificateBudgetRefusedDomains"',
      namespace: '"DeploymentsAI/Apps"',
      period: "300",
      statistic: '"Maximum"',
      FunctionName: undefined,
      QueueName: undefined,
    },
    errors: {
      ...notify,
      datapoints_to_alarm: "2",
      evaluation_periods: "3",
      metric_name: '"Errors"',
      namespace: '"AWS/Lambda"',
      period: "300",
      statistic: '"Sum"',
      FunctionName: "aws_lambda_function.domain_reconciler.function_name",
      QueueName: undefined,
    },
    scheduleDlq: {
      ...notify,
      datapoints_to_alarm: undefined,
      evaluation_periods: "1",
      metric_name: '"ApproximateNumberOfMessagesVisible"',
      namespace: '"AWS/SQS"',
      period: "300",
      statistic: '"Maximum"',
      FunctionName: undefined,
      QueueName: "aws_sqs_queue.domain_reconciler_schedule_dlq.name",
    },
  });
  expect(appRuntime).not.toContain("OrganizationCertificateBudgetRefusedDomains");
  expect(attribute(platformApps, "alarm_topic_arn")).toBe("module.ops_alerts.topic_arn");
});

test("lets only the platform API role ask apps-domains to converge a domain, and tells it the function name", () => {
  expect(policy("domain_reconciler_invoke")).toEqual([
    {
      sid: '"InvokeAppsDomains"',
      actions: ["lambda:InvokeFunction"],
      resources: "[aws_lambda_function.domain_reconciler.arn]",
      conditions: [],
    },
  ]);
  expect(
    attribute(block(appRuntime, 'resource "aws_iam_policy" "domain_reconciler_invoke"'), "name"),
  ).toBe('"apps-domains-invoke"');

  const attachment = block(
    readFileSync("infrastructure/modules/platform-api/apps-runtime-iam.tf", "utf8"),
    'resource "aws_iam_role_policy_attachment" "apps_domain_reconciler_invoke"',
  );
  expect({
    count: attribute(attachment, "count"),
    policyArn: attribute(attachment, "policy_arn"),
    role: attribute(attachment, "role"),
  }).toEqual({
    count: "var.apps_runtime == null ? 0 : 1",
    policyArn: "var.apps_runtime.domain_reconciler_invoke_policy_arn",
    role: "aws_iam_role.lambda.name",
  });
  const referencingFiles = readdirSync("infrastructure", { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".tf") && !path.includes(".terraform"))
    .filter((path) =>
      readFileSync(join("infrastructure", path), "utf8").includes(
        "domain_reconciler_invoke_policy_arn",
      ),
    )
    .sort();
  expect(referencingFiles).toEqual([
    "modules/app-runtime/outputs.tf",
    "modules/platform-api/apps-runtime-iam.tf",
    "modules/platform-api/variables.tf",
    "modules/platform/identity-and-api.tf",
  ]);

  const platformApi = readFileSync("infrastructure/modules/platform/identity-and-api.tf", "utf8");
  const apiRuntime = blockAt(platformApi, platformApi.indexOf("platform_api_apps_runtime = "));
  expect({
    functionName: attribute(apiRuntime, "APPS_DOMAIN_RECONCILER_FUNCTION_NAME"),
    policyArn: attribute(apiRuntime, "domain_reconciler_invoke_policy_arn"),
  }).toEqual({
    functionName: "module.app_runtime[0].domain_reconciler_function_name",
    policyArn: "module.app_runtime[0].domain_reconciler_invoke_policy_arn",
  });
  expect(attribute(block(appRuntime, 'output "domain_reconciler_function_name"'), "value")).toBe(
    "aws_lambda_function.domain_reconciler.function_name",
  );
});
