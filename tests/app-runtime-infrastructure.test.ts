import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPS_API_ENV } from "../functions/api/src/apps-api.ts";
import { DEFAULT_LIMITS } from "../packages/app-database/src/limits.ts";
import { MAX_GATEWAY_TASKS_DURING_DEPLOY } from "../packages/app-database/src/provision.ts";
import {
  PROVISION_INVOCATION_ATTEMPTS,
  PROVISION_SETTLE_MILLISECONDS,
} from "../packages/db/src/apps/lifecycle.ts";
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
const platformNetwork = readFileSync("infrastructure/modules/platform/network.tf", "utf8");

function blocks(source: string, resourceType: string) {
  return [...source.matchAll(new RegExp(`resource "${resourceType}" "([^"]+)"`, "gu"))].map(
    (match) => block(source, match[0]),
  );
}

function localBlock(local: string, key: string) {
  const value = blockAt(appRuntime, appRuntime.indexOf(`${local} = {`));
  return blockAt(value, value.indexOf(`${key} = {`));
}

const edgeDistributions = {
  apps: block(appRuntime, 'resource "aws_cloudfront_distribution" "apps"'),
  customDomains: block(
    appRuntime,
    'resource "aws_cloudfront_multitenant_distribution" "custom_domains"',
  ),
};

test("turns on IAM database auth, the Data API, and storage encryption", () => {
  const cluster = block(appRuntime, 'resource "aws_rds_cluster" "apps"');
  expect(attribute(cluster, "engine")).toBe('"aurora-postgresql"');
  expect(attribute(cluster, "iam_database_authentication_enabled")).toBe("true");
  expect(attribute(cluster, "enable_http_endpoint")).toBe("true");
  expect(attribute(cluster, "storage_encrypted")).toBe("true");
  expect(attribute(cluster, "manage_master_user_password")).toBe("true");
});

test("rejects unencrypted connections through the cluster parameter group", () => {
  const cluster = block(appRuntime, 'resource "aws_rds_cluster" "apps"');
  expect(attribute(cluster, "db_cluster_parameter_group_name")).toBe(
    "aws_rds_cluster_parameter_group.apps.name",
  );
  const parameterGroup = block(appRuntime, 'resource "aws_rds_cluster_parameter_group" "apps"');
  expect(attribute(parameterGroup, "name")).toBe('"rds.force_ssl"');
  expect(attribute(parameterGroup, "value")).toBe('"1"');
});

test("lets an idle cluster pause at zero capacity", () => {
  const scaling = block(appRuntime, "  serverlessv2_scaling_configuration");
  expect(attribute(scaling, "min_capacity")).toBe("var.min_capacity");
  expect(attribute(scaling, "seconds_until_auto_pause")).toBe("var.seconds_until_auto_pause");
  expect(attribute(block(appRuntime, 'variable "min_capacity"'), "default")).toBe("0");
  expect(attribute(block(appRuntime, 'variable "seconds_until_auto_pause"'), "default")).toBe(
    "300",
  );
  expect(platformApps).not.toMatch(/min_capacity|seconds_until_auto_pause/u);
});

test("admits Postgres only from the security groups the module creates for its clients", () => {
  const cluster = block(appRuntime, 'resource "aws_rds_cluster" "apps"');
  expect(attribute(cluster, "vpc_security_group_ids")).toBe("[aws_security_group.cluster.id]");
  expect(attribute(cluster, "port")).toBe("local.database_port");
  expect(attribute(appRuntime, "database_port")).toBe("5432");
  expect(block(appRuntime, 'resource "aws_security_group" "cluster"')).not.toMatch(
    /ingress|egress/u,
  );

  const clusterIngress = blocks(appRuntime, "aws_vpc_security_group_ingress_rule").filter(
    (rule) => attribute(rule, "security_group_id") === "aws_security_group.cluster.id",
  );
  expect(clusterIngress).toHaveLength(1);
  const [ingress = ""] = clusterIngress;
  expect(attribute(ingress, "for_each")).toBe("aws_security_group.client");
  expect(attribute(ingress, "security_group_id")).toBe("aws_security_group.cluster.id");
  expect(attribute(ingress, "referenced_security_group_id")).toBe("each.value.id");
  expect(attribute(ingress, "from_port")).toBe("local.database_port");
  expect(attribute(ingress, "to_port")).toBe("local.database_port");
  expect(ingress).not.toMatch(/cidr|prefix_list/u);

  const clients = block(appRuntime, 'resource "aws_security_group" "client"');
  expect(attribute(clients, "for_each")).toBe("local.database_clients");
  expect(clients).not.toMatch(/ingress/u);
  const clientNames = [
    ...block(appRuntime, "  database_clients =").matchAll(/^\s*([a-z-]+)\s*=/gmu),
  ].map((match) => match[1]);
  expect(clientNames).toEqual(["database-function", "gateway"]);
  expect(attribute(block(appRuntime, 'output "client_security_group_ids"'), "value")).toBe(
    "{ for key, group in aws_security_group.client : key => group.id }",
  );
});

test("creates the shared private network whenever apps are enabled", () => {
  const networkTrigger = block(platformNetwork, "locals");
  expect(networkTrigger).toMatch(/platform_network_enabled = \([^)]*var\.apps_enabled/u);
  expect(attribute(platformApps, "count")).toBe("var.apps_enabled ? 1 : 0");
  expect(attribute(platformApps, "vpc_id")).toBe("module.platform_network[0].vpc_id");
  expect(attribute(platformApps, "private_subnet_ids")).toBe(
    "module.platform_network[0].private_subnet_ids",
  );
});

test("leaves apps disabled unless a root opts in", () => {
  const platformVariables = readFileSync(
    "infrastructure/modules/platform/variables-apps.tf",
    "utf8",
  );
  expect(attribute(block(platformVariables, 'variable "apps_enabled"'), "default")).toBe("false");
  const customerApps = readFileSync(
    "infrastructure/environments/customer/apps.variables.tf",
    "utf8",
  );
  expect(attribute(block(customerApps, 'variable "apps_enabled"'), "default")).toBe("false");
  const customerMain = readFileSync("infrastructure/environments/customer/main.tf", "utf8");
  expect(customerMain).toMatch(/^\s*apps_enabled\s*=\s*var\.apps_enabled$/mu);
});

test("lets the customer deploy role manage apps- IAM roles and policies", () => {
  const bootstrap = readFileSync("infrastructure/bootstrap/customer/main.tf", "utf8");
  const prefixes = [
    ...(/workload_name_prefixes\s*=\s*\[([^\]]*)\]/u.exec(bootstrap)?.[1] ?? "").matchAll(
      /"([^"]+)"/gu,
    ),
  ].map((match) => match[1]);
  expect(prefixes).toContain("apps-");
});

test("sends the exact app content security policy and transport headers on every response, without HSTS subdomains on custom domains", () => {
  expect(attribute(appRuntime, "content_security_policy")).toBe(
    `"default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'"`,
  );
  const headers = (name: string) => {
    const policy = block(appRuntime, `resource "aws_cloudfront_response_headers_policy" "${name}"`);
    return {
      contentSecurityPolicy: attribute(policy, "content_security_policy"),
      contentTypeOptions: /content_type_options \{\s+override = true\s+\}/u.test(policy),
      hstsIncludeSubdomains: attribute(policy, "include_subdomains"),
      hstsMaxAge: attribute(policy, "access_control_max_age_sec"),
      overrides: [...policy.matchAll(/override\s*=\s*(\S+)/gu)].map((match) => match[1]),
      referrerPolicy: attribute(policy, "referrer_policy"),
    };
  };
  const shared = {
    contentSecurityPolicy: "local.content_security_policy",
    contentTypeOptions: true,
    hstsMaxAge: "31536000",
    overrides: ["true", "true", "true", "true"],
    referrerPolicy: '"strict-origin-when-cross-origin"',
  };
  expect({ apps: headers("apps"), customDomains: headers("custom_domains") }).toEqual({
    apps: { ...shared, hstsIncludeSubdomains: "true" },
    customDomains: { ...shared, hstsIncludeSubdomains: "false" },
  });

  expect(
    Object.values(edgeDistributions).map((distribution) =>
      ["response_headers_policy_id", "function_arn"].map((name) =>
        [...distribution.matchAll(new RegExp(`${name}\\s*=\\s*(\\S+)`, "gu"))].map(
          (match) => match[1],
        ),
      ),
    ),
  ).toEqual(
    ["apps", "custom_domains"].map((policy) => [
      [
        `aws_cloudfront_response_headers_policy.${policy}.id`,
        `aws_cloudfront_response_headers_policy.${policy}.id`,
      ],
      ["aws_cloudfront_function.viewer_request.arn", "aws_cloudfront_function.viewer_request.arn"],
    ]),
  );
});

test("reaches the gateway only through the CloudFront VPC origin on the shared internal ALB", () => {
  const ingress = blocks(appRuntime, "aws_vpc_security_group_ingress_rule");
  expect(
    ingress.map((rule) => [
      attribute(rule, "security_group_id"),
      attribute(rule, "referenced_security_group_id"),
      attribute(rule, "from_port"),
    ]),
  ).toEqual([
    ["aws_security_group.cluster.id", "each.value.id", "local.database_port"],
    [
      "var.internal_load_balancer.security_group_id",
      "data.aws_security_group.cloudfront_vpc_origins.id",
      "local.gateway_listener_port",
    ],
    [
      'aws_security_group.client["gateway"].id',
      "var.internal_load_balancer.security_group_id",
      "local.gateway_port",
    ],
  ]);
  expect(ingress.filter((rule) => /cidr|prefix_list/u.test(rule))).toEqual([]);
  expect(
    attribute(block(appRuntime, 'data "aws_security_group" "cloudfront_vpc_origins"'), "values"),
  ).toBe('["CloudFront-VPCOrigins-Service-SG"]');

  const vpcOrigin = block(appRuntime, 'resource "aws_cloudfront_vpc_origin" "gateway"');
  expect(attribute(vpcOrigin, "arn")).toBe("var.internal_load_balancer.arn");
  expect(attribute(vpcOrigin, "https_port")).toBe("local.gateway_listener_port");
  expect(attribute(vpcOrigin, "origin_protocol_policy")).toBe('"https-only"');
  const listener = block(appRuntime, 'resource "aws_lb_listener" "gateway"');
  expect(attribute(listener, "load_balancer_arn")).toBe("var.internal_load_balancer.arn");
  expect(attribute(listener, "port")).toBe("local.gateway_listener_port");
  expect(attribute(listener, "protocol")).toBe('"HTTPS"');

  const gatewayOrigin = localBlock("edge_origins", "gateway");
  expect(attribute(gatewayOrigin, "id")).toBe("aws_cloudfront_vpc_origin.gateway.id");
  expect(gatewayOrigin).not.toMatch(/custom_origin_config/u);
  for (const distribution of Object.values(edgeDistributions)) {
    expect(distribution).not.toMatch(/custom_origin_config/u);
    expect(attribute(distribution, "for_each")).toBe("local.edge_origins");
    const defaultBehavior = distribution.slice(distribution.indexOf("default_cache_behavior {"));
    expect(attribute(defaultBehavior, "target_origin_id")).toBe('"gateway"');
  }

  const service = block(appRuntime, 'resource "aws_ecs_service" "gateway"');
  expect(attribute(service, "assign_public_ip")).toBe("false");
  expect(attribute(service, "security_groups")).toBe('[aws_security_group.client["gateway"].id]');
});

test("sizes app role connection limits for every gateway task a rolling deploy can run", () => {
  const service = block(appRuntime, 'resource "aws_ecs_service" "gateway"');
  expect({
    desiredCount: attribute(service, "desired_count"),
    maximumPercent: attribute(service, "deployment_maximum_percent"),
    maximumTasks: MAX_GATEWAY_TASKS_DURING_DEPLOY,
  }).toEqual({
    desiredCount: "var.high_availability_enabled ? 2 : 1",
    maximumPercent: "200",
    maximumTasks: (2 * 200) / 100,
  });
});

test("lets only the gateway and the apps-database Lambda connect to Postgres, as the contract's roles", () => {
  const databaseUser = (role: string) => `\${local.database_users}/${role}`;
  const connectResources = (documentName: string) => {
    const document = block(appRuntime, `data "aws_iam_policy_document" "${documentName}"`);
    const connect = statements(document).filter((statement) =>
      statement.includes('"rds-db:connect"'),
    );
    expect(connect).toHaveLength(1);
    expect(listAttribute(connect[0] ?? "", "actions")).toEqual(["rds-db:connect"]);
    return listAttribute(connect[0] ?? "", "resources");
  };
  expect(connectResources("gateway_task")).toEqual([
    databaseUser("app_*_viewer"),
    databaseUser("app_*_editor"),
    databaseUser("app_*_visitor"),
  ]);
  expect(connectResources("database_function")).toEqual([
    databaseUser("platform_provisioner"),
    databaseUser("app_*_owner"),
    databaseUser("app_*_viewer"),
  ]);
  expect(attribute(appRuntime, "database_users")).toBe(
    `"arn:\${data.aws_partition.current.partition}:rds-db:\${data.aws_region.current.region}:\${data.aws_caller_identity.current.account_id}:dbuser:\${aws_rds_cluster.apps.cluster_resource_id}"`,
  );

  expect(
    attribute(block(appRuntime, 'resource "aws_iam_role_policy" "gateway_task"'), "role"),
  ).toBe("aws_iam_role.gateway_task.id");
  expect(
    attribute(block(appRuntime, 'resource "aws_iam_role_policy" "database_function"'), "role"),
  ).toBe("aws_iam_role.database_function.id");
  expect(
    attribute(block(appRuntime, 'resource "aws_ecs_task_definition" "gateway"'), "task_role_arn"),
  ).toBe("aws_iam_role.gateway_task.arn");
  expect(attribute(block(appRuntime, 'resource "aws_lambda_function" "database"'), "role")).toBe(
    "aws_iam_role.database_function.arn",
  );

  const grantingFiles = readdirSync("infrastructure", { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".tf") && !path.includes(".terraform"))
    .sort()
    .flatMap((path) => {
      const count =
        readFileSync(join("infrastructure", path), "utf8").split('"rds-db:connect"').length - 1;
      return count === 0 ? [] : [[path, count]];
    });
  expect(grantingFiles).toEqual([
    ["modules/app-runtime/database-function.tf", 1],
    ["modules/app-runtime/gateway.tf", 1],
  ]);
});

test("keeps the apps bucket private and lets CloudFront read only release objects", () => {
  const publicAccess = block(appRuntime, 'resource "aws_s3_bucket_public_access_block" "apps"');
  expect(attribute(publicAccess, "bucket")).toBe("aws_s3_bucket.apps.id");
  for (const setting of [
    "block_public_acls",
    "block_public_policy",
    "ignore_public_acls",
    "restrict_public_buckets",
  ]) {
    expect(attribute(publicAccess, setting)).toBe("true");
  }
  expect(
    attribute(
      block(appRuntime, 'resource "aws_s3_bucket_server_side_encryption_configuration" "apps"'),
      "sse_algorithm",
    ),
  ).toBe('"AES256"');

  const allows = statements(
    block(appRuntime, 'data "aws_iam_policy_document" "apps_bucket"'),
  ).filter((statement) => !/effect\s*=\s*"Deny"/u.test(statement));
  expect(allows).toHaveLength(1);
  const [cloudFrontRead = ""] = allows;
  expect(listAttribute(cloudFrontRead, "actions")).toEqual(["s3:GetObject"]);
  expect(attribute(cloudFrontRead, "resources")).toBe("[local.release_objects]");
  expect(listAttribute(cloudFrontRead, "identifiers")).toEqual(["cloudfront.amazonaws.com"]);
  expect(attribute(cloudFrontRead, "values")).toBe(
    "[aws_cloudfront_distribution.apps.arn, aws_cloudfront_multitenant_distribution.custom_domains.arn]",
  );
  expect(attribute(appRuntime, "release_objects")).toBe(
    `"\${aws_s3_bucket.apps.arn}/apps/*/releases/*"`,
  );
});

test("gives the worker, the API, and the governance worker the apps-database invoke policy and environment", () => {
  const platformWorker = readFileSync("infrastructure/modules/platform/agent-runtime.tf", "utf8");
  expect(platformWorker).toContain("try(module.app_runtime[0].callers.environment, {}),");
  expect(platformWorker).toContain(
    "apps_database_invoke = module.app_runtime[0].callers.invoke_policy_arn",
  );
  expect(platformWorker).toContain(
    "apps_release_upload  = module.app_runtime[0].callers.release_upload_policy_arn",
  );
  const platformApi = readFileSync("infrastructure/modules/platform/identity-and-api.tf", "utf8");
  expect(attribute(platformApi, "apps_runtime")).toBe("local.platform_api_apps_runtime");
  const apiRuntime = blockAt(platformApi, platformApi.indexOf("platform_api_apps_runtime = "));
  expect(attribute(apiRuntime, APPS_API_ENV.customDomainTarget)).toBe(
    "module.app_runtime[0].custom_domains.routing_endpoint",
  );
  expect(attribute(apiRuntime, APPS_API_ENV.reservedHostnames)).toBe(
    'join(",", local.apps_reserved_hostnames)',
  );
  const reserved = /apps_reserved_hostnames = compact\(\[\n([\s\S]*?)\n\s*\]\)/u.exec(platformApi);
  expect(reserved?.[1]?.split("\n").map((line) => line.trim().replace(/,$/u, ""))).toEqual([
    "var.platform_api_domain_name",
    "var.platform_identity_domain_name",
    'split(":", trimprefix(var.platform_identity_application_origin, "https://"))[0]',
    "var.stream_gateway_domain_name",
  ]);
  const apiAttachments = readFileSync(
    "infrastructure/modules/platform-api/apps-runtime-iam.tf",
    "utf8",
  );
  expect(attribute(apiAttachments, "api")).toBe("aws_iam_role.lambda.name");
  expect(attribute(apiAttachments, "governance-worker")).toBe(
    "aws_iam_role.governance_worker.name",
  );
  expect(attribute(apiAttachments, "policy_arn")).toBe("var.apps_runtime.invoke_policy_arn");

  const invoke = statements(block(appRuntime, 'data "aws_iam_policy_document" "database_invoke"'));
  expect(invoke.map((statement) => listAttribute(statement, "actions"))).toEqual([
    ["lambda:InvokeFunction"],
  ]);
  expect(attribute(invoke[0] ?? "", "resources")).toBe("[aws_lambda_function.database.arn]");
  const environment = block(appRuntime, 'output "callers"');
  expect([...environment.matchAll(/^\s+(APPS_[A-Z_]+)\s*=/gmu)].map((match) => match[1])).toEqual([
    "APPS_BUCKET",
    "APPS_DATABASE_FUNCTION_NAME",
    "APPS_DOMAIN",
  ]);
});

test("lets the apps-database Lambda write exports and list and delete only app objects", () => {
  const s3Grants = statements(
    block(appRuntime, 'data "aws_iam_policy_document" "database_function"'),
  ).filter((statement) => statement.includes('"s3:'));
  expect(
    s3Grants.map((statement) => ({
      actions: listAttribute(statement, "actions"),
      resources: attribute(statement, "resources"),
      sid: attribute(statement, "sid"),
    })),
  ).toEqual([
    {
      actions: ["s3:AbortMultipartUpload", "s3:PutObject"],
      resources: "[local.export_objects]",
      sid: '"WriteExports"',
    },
    { actions: ["s3:ListBucket"], resources: "[aws_s3_bucket.apps.arn]", sid: '"ListAppObjects"' },
    {
      actions: ["s3:DeleteObject"],
      resources: `["\${aws_s3_bucket.apps.arn}/apps/*"]`,
      sid: '"EraseAppObjects"',
    },
  ]);
  const list = s3Grants[1] ?? "";
  expect({
    test: attribute(list, "test"),
    values: listAttribute(list, "values"),
    variable: attribute(list, "variable"),
  }).toEqual({ test: '"StringLike"', values: ["apps/*"], variable: '"s3:prefix"' });
});

test("gives the apps-database Lambda time to finish an export and ends every provision inside the erase settle window", () => {
  const lambda = block(appRuntime, 'resource "aws_lambda_function" "database"');
  const timeoutMs = Number(attribute(lambda, "timeout")) * 1000;
  expect({
    exportFits: timeoutMs > DEFAULT_LIMITS.exportDeadlineMs + DEFAULT_LIMITS.graceMs,
    provisionSettles: timeoutMs * PROVISION_INVOCATION_ATTEMPTS < PROVISION_SETTLE_MILLISECONDS,
  }).toEqual({ exportFits: true, provisionSettles: true });
});

test("lets only the governance worker read app exports", () => {
  const exportRead = statements(block(appRuntime, 'data "aws_iam_policy_document" "export_read"'));
  expect(
    exportRead.map((statement) => ({
      actions: listAttribute(statement, "actions"),
      resources: attribute(statement, "resources"),
    })),
  ).toEqual([{ actions: ["s3:GetObject"], resources: "[local.export_objects]" }]);
  expect(attribute(appRuntime, "export_objects")).toBe(
    `"\${aws_s3_bucket.apps.arn}/apps/*/exports/*"`,
  );
  expect(attribute(block(appRuntime, 'resource "aws_iam_policy" "export_read"'), "name")).toBe(
    '"apps-export-read"',
  );
  expect(attribute(block(appRuntime, 'output "callers"'), "export_read_policy_arn")).toBe(
    "aws_iam_policy.export_read.arn",
  );

  const attachment = block(
    readFileSync("infrastructure/modules/platform-api/apps-runtime-iam.tf", "utf8"),
    'resource "aws_iam_role_policy_attachment" "apps_export_read"',
  );
  expect({
    count: attribute(attachment, "count"),
    policyArn: attribute(attachment, "policy_arn"),
    role: attribute(attachment, "role"),
  }).toEqual({
    count: "var.apps_runtime == null ? 0 : 1",
    policyArn: "var.apps_runtime.export_read_policy_arn",
    role: "aws_iam_role.governance_worker.name",
  });
  const referencingFiles = readdirSync("infrastructure", { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".tf") && !path.includes(".terraform"))
    .filter((path) =>
      readFileSync(join("infrastructure", path), "utf8").includes("export_read_policy_arn"),
    )
    .sort();
  expect(referencingFiles).toEqual([
    "modules/app-runtime/outputs.tf",
    "modules/platform-api/apps-runtime-iam.tf",
    "modules/platform-api/variables.tf",
  ]);
});

test("lets the worker write app sessions for app.dev_token and no other identity record", () => {
  const sessions = statements(block(appRuntime, 'data "aws_iam_policy_document" "dev_sessions"'));
  expect(
    sessions.map((statement) => ({
      actions: listAttribute(statement, "actions"),
      resources: attribute(statement, "resources"),
      test: attribute(statement, "test"),
      values: listAttribute(statement, "values"),
      variable: attribute(statement, "variable"),
    })),
  ).toEqual([
    {
      actions: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"],
      resources: "[var.identity_table.arn]",
      test: '"ForAllValues:StringLike"',
      values: ["APP-SESSION#*"],
      variable: '"dynamodb:LeadingKeys"',
    },
  ]);
  expect(attribute(block(appRuntime, 'resource "aws_iam_policy" "dev_sessions"'), "name")).toBe(
    '"apps-dev-sessions"',
  );
  expect(attribute(block(appRuntime, 'output "callers"'), "dev_session_policy_arn")).toBe(
    "aws_iam_policy.dev_sessions.arn",
  );
  expect(readFileSync("infrastructure/modules/platform/agent-runtime.tf", "utf8")).toContain(
    "apps_dev_sessions    = module.app_runtime[0].callers.dev_session_policy_arn",
  );
});

test("lets the worker create release objects only with If-None-Match and read them back", () => {
  const upload = statements(block(appRuntime, 'data "aws_iam_policy_document" "release_upload"'));
  expect(
    upload.map((statement) => ({
      actions: listAttribute(statement, "actions"),
      resources: attribute(statement, "resources"),
      test: attribute(statement, "test"),
      values: attribute(statement, "values"),
      variable: attribute(statement, "variable"),
    })),
  ).toEqual([
    {
      actions: ["s3:PutObject"],
      resources: "[local.release_objects]",
      test: '"Null"',
      values: '["false"]',
      variable: '"s3:if-none-match"',
    },
    {
      actions: ["s3:GetObject"],
      resources: "[local.release_objects]",
      test: undefined,
      values: undefined,
      variable: undefined,
    },
  ]);
});

test("builds both distributions' origins and behaviors from the same locals", () => {
  const behaviorKeys = [
    "allowed_methods",
    "cache_policy_id",
    "cached_methods",
    "compress",
    "origin_request_policy_id",
    "path_pattern",
    "viewer_protocol_policy",
  ];
  const behaviors = ["gateway", "releases"];
  expect(
    behaviors.map((behavior) =>
      [...localBlock("edge_behaviors", behavior).matchAll(/^ {6}(\w+)\s*=/gmu)].map(
        (match) => match[1],
      ),
    ),
  ).toEqual([behaviorKeys, behaviorKeys]);
  expect(attribute(localBlock("edge_origins", "releases"), "origin_access_control_id")).toBe(
    "aws_cloudfront_origin_access_control.releases.id",
  );
  expect(
    Object.values(edgeDistributions).map((distribution) => ({
      origin: blockAt(distribution, distribution.indexOf('dynamic "origin"'))
        .split("\n")
        .map((line) => line.trim().replace(/\s+=\s+/u, " = "))
        .filter((line) => / = (?:origin|vpc_origin_config)\./u.test(line)),
      origins: attribute(distribution, "for_each"),
      reads: behaviors.map((behavior) =>
        [
          ...new Set(
            [
              ...distribution.matchAll(
                new RegExp(`local\\.edge_behaviors\\.${behavior}\\.(\\w+)`, "gu"),
              ),
            ].map((match) => match[1] ?? ""),
          ),
        ].sort((left, right) => left.localeCompare(right)),
      ),
      targets: [...distribution.matchAll(/target_origin_id\s*=\s*(\S+)/gu)].map(
        (match) => match[1],
      ),
    })),
  ).toEqual(
    [
      [
        "origin_access_control_id = origin.value.origin_access_control_id",
        "origin_id = origin.key",
      ],
      ["id = origin.key", "origin_access_control_id = origin.value.origin_access_control_id"],
    ].map((originIdentity) => ({
      origin: [
        "domain_name = origin.value.domain_name",
        ...originIdentity,
        "for_each = origin.value.vpc_origin[*]",
        "origin_read_timeout = vpc_origin_config.value.read_timeout",
        "vpc_origin_id = vpc_origin_config.value.id",
      ],
      origins: "local.edge_origins",
      reads: [behaviorKeys.filter((key) => key !== "path_pattern"), behaviorKeys],
      targets: ['"releases"', '"gateway"'],
    })),
  );
});

test("serves custom domains from a tenant-only distribution whose tenants must name an app", () => {
  const distribution = edgeDistributions.customDomains;
  const parameter = blockAt(distribution, distribution.indexOf("parameter_definition {"));
  expect({
    certificate: attribute(distribution, "acm_certificate_arn"),
    parameter: attribute(parameter, "name"),
    required: attribute(parameter, "required"),
    sslSupportMethod: attribute(distribution, "ssl_support_method"),
    tlsMinimum: attribute(distribution, "minimum_protocol_version"),
  }).toEqual({
    certificate: "aws_acm_certificate_validation.edge.certificate_arn",
    parameter: '"appId"',
    required: "true",
    sslSupportMethod: '"sni-only"',
    tlsMinimum: '"TLSv1.2_2021"',
  });
  expect(distribution).not.toMatch(/price_class|is_ipv6_enabled|aliases|_ttl|forwarded_values/u);

  const connectionGroup = block(
    appRuntime,
    'resource "aws_cloudfront_connection_group" "custom_domains"',
  );
  expect({
    enabled: attribute(connectionGroup, "enabled"),
    ipv6Enabled: attribute(connectionGroup, "ipv6_enabled"),
  }).toEqual({ enabled: "true", ipv6Enabled: "true" });

  const output = block(appRuntime, 'output "custom_domains"');
  expect(
    Object.fromEntries(
      [...output.matchAll(/^ {4}(\w+)\s*=\s*(\S+)$/gmu)].map((match) => [match[1], match[2]]),
    ),
  ).toEqual({
    connection_group_id: "aws_cloudfront_connection_group.custom_domains.id",
    distribution_arn: "aws_cloudfront_multitenant_distribution.custom_domains.arn",
    distribution_id: "aws_cloudfront_multitenant_distribution.custom_domains.id",
    routing_endpoint: "aws_cloudfront_connection_group.custom_domains.routing_endpoint",
  });
});
