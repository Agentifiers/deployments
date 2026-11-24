import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER,
  INGRESS_ATTACHMENT_OBJECT_NAME,
  INPUT_FILE_TEXT_OBJECT_NAME,
  makeDynamoDatabase,
  makeOAuthRefreshClaimPersistence,
  type OAuthRefreshClaimTarget,
  type Ulid,
} from "../packages/db/src/index.ts";
import { INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS } from "../packages/ingress-media/src/index.ts";

const providerRuntime = readFileSync(
  "infrastructure/modules/channel-provider-runtime/main.tf",
  "utf8",
);
const providerRuntimeFunctions = readFileSync(
  "infrastructure/modules/channel-provider-runtime/runtime-functions.tf",
  "utf8",
);
const providerRuntimeVariables = readFileSync(
  "infrastructure/modules/channel-provider-runtime/variables.tf",
  "utf8",
);
const stackChannels = readFileSync(
  "infrastructure/modules/platform/events-and-channels.tf",
  "utf8",
);
const stackComposition = ["identity-and-api.tf", "events-and-channels.tf", "agent-runtime.tf"]
  .map((file) => readFileSync(`infrastructure/modules/platform/${file}`, "utf8"))
  .join("\n");
const inboundRuntime = readFileSync("infrastructure/modules/inbound-runtime/main.tf", "utf8");
const stackData = readFileSync("infrastructure/modules/platform/data.tf", "utf8");
const localRuntime = readFileSync("infrastructure/environments/local/main.tf", "utf8");
const localOutputs = readFileSync("infrastructure/environments/local/outputs.tf", "utf8");

const terraformBlock = (source: string, start: number): string => {
  let depth = 0;
  let opened = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      opened = true;
    }
    if (source[index] === "}") depth -= 1;
    if (opened && depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unterminated OpenTofu block at ${start}`);
};

const terraformResourceBody = (
  source: string,
  type: string,
  name: string,
  kind: "data" | "resource" = "resource",
): string => {
  const start = source.indexOf(`${kind} "${type}" "${name}" {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return terraformBlock(source, start);
};

test("orders generic channel ingress through a route-scoped FIFO queue", () => {
  expect(providerRuntime).toContain('each.key == "channel-ingress" ? ".fifo" : ""');
  expect(providerRuntime).toMatch(/fifo_queue\s+= each\.key == "channel-ingress"/u);
  const ingressMapping = terraformResourceBody(
    inboundRuntime,
    "aws_lambda_event_source_mapping",
    "runtime",
  );
  expect(ingressMapping).toMatch(/batch_size\s+= 1/u);
  expect(ingressMapping).not.toContain("maximum_batching_window_in_seconds");
});

test("allows authenticated ingress to journal normalized sources before FIFO publication", () => {
  expect(providerRuntime).toContain('sid = "JournalIngressAcceptance"');
  expect(providerRuntime).toContain("var.execution_table_arn");
  expect(providerRuntimeFunctions).toContain(
    "DEPLOYMENTS_AI_EXECUTION_TABLE                  = var.execution_table_name",
  );
});

test("provisions the durable ingress flush trigger for local execution", () => {
  expect(localRuntime).toContain("channel-ingress-flush = {");
  expect(localOutputs).toContain(
    'DEPLOYMENTS_AI_CHANNEL_INGRESS_FLUSH_QUEUE_URL = local.queue_urls["channel-ingress-flush"]',
  );
});

test("lets the flush reach captured attachments only through the tenant-tagged capture role and the extraction function", () => {
  const flush = terraformResourceBody(inboundRuntime, "aws_lambda_function", "flush");
  expect(flush).toMatch(/role\s+= aws_iam_role\.flush\.arn/u);
  expect(flush).toMatch(
    /DEPLOYMENTS_AI_CREDENTIAL_VAULT_READER_ROLE_ARN\s+= var\.credential_vault_reader_role_arn/u,
  );
  expect(flush).toMatch(
    /DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME\s+= var\.document_extraction_function\.function_name/u,
  );
  expect(inboundRuntime).toMatch(
    /DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN\s+= var\.ingress_attachment_capture_role_arn/u,
  );
  const runtime = terraformResourceBody(inboundRuntime, "aws_lambda_function", "runtime");
  expect(runtime).toMatch(/role\s+= aws_iam_role\.runtime\.arn/u);
  expect(runtime).not.toContain("DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME");
  const attachments = terraformResourceBody(
    inboundRuntime,
    "aws_iam_policy_document",
    "flush_attachments",
    "data",
  );
  expect(attachments).toMatch(
    /sid\s+= "AssumeCredentialVaultReader"\s+actions\s+= \["sts:AssumeRole", "sts:TagSession"\]\s+resources = \[var\.credential_vault_reader_role_arn\]/u,
  );
  expect(attachments).toMatch(
    /sid\s+= "AssumeIngressAttachmentCapture"\s+actions\s+= \["sts:AssumeRole", "sts:TagSession"\]\s+resources = \[var\.ingress_attachment_capture_role_arn\]/u,
  );
  expect(attachments).toMatch(
    /sid\s+= "InvokeDocumentExtraction"\s+actions\s+= \["lambda:InvokeFunction"\]\s+resources = \[var\.document_extraction_function\.arn\]/u,
  );
  expect(terraformResourceBody(inboundRuntime, "aws_iam_role_policy", "flush_attachments")).toMatch(
    /role\s+= aws_iam_role\.flush\.id/u,
  );
  expect(inboundRuntime).not.toContain('"s3:');
  expect(inboundRuntime).not.toContain('"kms:');
  expect(inboundRuntime).not.toContain("/customer/");
  const shared = terraformResourceBody(
    inboundRuntime,
    "aws_iam_policy_document",
    "runtime",
    "data",
  );
  expect(shared).not.toContain('"sts:');
  expect(shared).not.toContain('"lambda:');
  expect(providerRuntime).toContain(
    'each.key == "reader" ? var.credential_vault_reader_principal_arns : []',
  );
  expect(stackChannels).toMatch(
    /credential_vault_reader_principal_arns\s+= var\.agent_runtime_enabled \? \[module\.inbound_runtime\[0\]\.channel_ingress_flush_role_arn\] : \[\]/u,
  );
  const inboundRuntimeModule = stackChannels.slice(
    stackChannels.indexOf('module "inbound_runtime" {'),
    stackChannels.indexOf('module "agent_email" {'),
  );
  expect(inboundRuntimeModule).toMatch(
    /credential_vault_reader_role_arn\s+= module\.channel_provider_runtime\[0\]\.credential_vault_role_arns\["reader"\]/u,
  );
  expect(inboundRuntimeModule).toMatch(
    /ingress_attachment_capture_role_arn\s+= module\.platform_data\.ingress_attachment_capture_role_arn/u,
  );
  expect(inboundRuntimeModule).toMatch(
    /document_extraction_function\s+= \{ arn = module\.document_extraction\.function_arn, function_name = module\.document_extraction\.function_name \}/u,
  );
});

test("binds the attachment capture role to the source and text keys of the tenant its session is tagged with", () => {
  const capture = readFileSync(
    "infrastructure/modules/platform-data/ingress-attachment-capture.tf",
    "utf8",
  );
  const trust = terraformResourceBody(
    capture,
    "aws_iam_policy_document",
    "ingress_attachment_capture_assume",
    "data",
  );
  expect(trust).toContain('actions = ["sts:AssumeRole", "sts:TagSession"]');
  expect(trust).toMatch(
    /type\s+= "AWS"\s+identifiers = var\.ingress_attachment_capture_principal_arns/u,
  );
  expect(trust).toMatch(
    /test\s+= "ForAllValues:StringEquals"\s+variable = "aws:TagKeys"\s+values\s+= \["environmentId", "organizationId", "projectId"\]/u,
  );
  expect(trust).toMatch(
    /for_each = toset\(\["environmentId", "organizationId", "projectId"\]\)\s+content \{\s+test\s+= "Null"\s+variable = "aws:RequestTag\/\$\{condition\.key\}"\s+values\s+= \["false"\]/u,
  );
  expect(capture).toMatch(
    /tenant_input_file_prefix\s+= "\$\{local\.artifact_bucket_arn\}\/artifacts\/organizations\/\$\$\{aws:PrincipalTag\/organizationId\}\/projects\/\$\$\{aws:PrincipalTag\/projectId\}\/environments\/\$\$\{aws:PrincipalTag\/environmentId\}\/customer\/\*\/\*"/u,
  );
  const objectNames = new Map(
    [
      ...capture.matchAll(
        /(tenant_input_file_[a-z_]+)\s+= "\$\{local\.tenant_input_file_prefix\}\/([^"]+)"/gu,
      ),
    ].map(([, name, objectName]): [string, string | undefined] => [`local.${name}`, objectName]),
  );
  const source = INGRESS_ATTACHMENT_OBJECT_NAME;
  const text = `text/${INPUT_FILE_TEXT_OBJECT_NAME}`;
  expect([...objectNames.values()]).toEqual([source, text]);
  const policy = terraformResourceBody(
    capture,
    "aws_iam_policy_document",
    "ingress_attachment_capture",
    "data",
  );
  const objectAccess = [...policy.matchAll(/statement \{/gu)]
    .map(({ index }) => terraformBlock(policy, index))
    .filter((statement) => statement.includes('"s3:'))
    .map((statement) => ({
      actions: /actions\s+= \[([^\]]*)\]/u.exec(statement)?.[1],
      createOnly: /variable = "s3:if-none-match"\s+values\s+= \["\*"\]/u.test(statement),
      objects: /resources = \[([^\]]*)\]/u
        .exec(statement)?.[1]
        ?.split(", ")
        .map((resource) => objectNames.get(resource)),
    }));
  expect(objectAccess).toEqual([
    { actions: '"s3:PutObject"', createOnly: true, objects: [source, text] },
    { actions: '"s3:GetObject"', createOnly: false, objects: [source, text] },
    { actions: '"s3:GetObjectVersion"', createOnly: false, objects: [source] },
  ]);
  expect(policy).toMatch(
    /actions\s+= \["kms:Decrypt", "kms:GenerateDataKey"\]\s+resources = \[local\.data_kms_key_arn\]\s+condition \{\s+test\s+= "StringEquals"\s+variable = "kms:ViaService"/u,
  );
  expect(capture).not.toContain("organizations/*");
  expect(stackData).toMatch(
    /ingress_attachment_capture_principal_arns = concat\(\s+var\.agent_runtime_enabled && var\.channel_provider_runtime_enabled \? \[module\.inbound_runtime\[0\]\.channel_ingress_flush_role_arn\] : \[\],/u,
  );
});

test("sizes the flush so a burst's attachment capture fits the Lambda and the queue visibility", () => {
  const TEAMS_TOKEN_MINT_SECONDS = 10;
  const SUBMIT_ALLOWANCE_SECONDS = 10;
  const setting = (body: string, field: string) =>
    Number(new RegExp(`${field}\\s+= (\\d+)`, "u").exec(body)?.[1]);
  const batchSize = setting(
    terraformResourceBody(inboundRuntime, "aws_lambda_event_source_mapping", "flush"),
    "batch_size",
  );
  const timeout = setting(
    terraformResourceBody(inboundRuntime, "aws_lambda_function", "flush"),
    "timeout",
  );
  const visibility = setting(
    terraformResourceBody(inboundRuntime, "aws_sqs_queue", "flush"),
    "visibility_timeout_seconds",
  );
  const burstSeconds =
    INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS / 1_000 +
    TEAMS_TOKEN_MINT_SECONDS +
    SUBMIT_ALLOWANCE_SECONDS;

  expect(batchSize * burstSeconds).toBeLessThanOrEqual(timeout);
  // AWS asks for a visibility of at least six function timeouts so throttled batches can retry.
  expect(6 * timeout).toBeLessThanOrEqual(visibility);
});

test("gives confirmed provider delivery a durable conversation publication path", () => {
  expect(providerRuntimeVariables).toContain('variable "durable_streams_auth_secret_arn"');
  expect(providerRuntimeVariables).toContain('variable "durable_streams_base_url"');
  expect(providerRuntimeVariables).toContain('variable "network"');
  expect(providerRuntime).toContain('"ReadDurableStreamsAuthToken"');
  expect(providerRuntime).toContain('"VpcNetworking"');
  expect(providerRuntime).toContain('"dynamodb:Query"');
  expect(providerRuntime).toContain('"${var.execution_table_arn}/index/*"');
  expect(providerRuntimeFunctions).toContain(
    "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN = var.durable_streams_auth_secret_arn",
  );
  expect(providerRuntimeFunctions).toContain(
    "DEPLOYMENTS_AI_DURABLE_STREAMS_URL             = var.durable_streams_base_url",
  );
  expect(providerRuntimeFunctions).toContain('each.key == "channel-delivery"');
  expect(stackChannels).toMatch(/durable_streams_auth_secret_arn\s+=.*module\.durable_streams/u);
  expect(stackChannels).toMatch(/durable_streams_base_url\s+=.*module\.durable_streams/u);
});

const providerGateway = readFileSync(
  "infrastructure/modules/channel-provider-runtime/gateway-and-alarms.tf",
  "utf8",
);
const providerOutputs = readFileSync(
  "infrastructure/modules/channel-provider-runtime/outputs.tf",
  "utf8",
);
const platformApiPolicy = readFileSync("infrastructure/modules/platform-api/api-iam.tf", "utf8");
const platformApiFunction = readFileSync(
  "infrastructure/modules/platform-api/governance-runtime.tf",
  "utf8",
);
const agentRuntime = readFileSync("infrastructure/modules/agent-runtime/main.tf", "utf8");

const dynamicStatement = (source: string, sid: string): string => {
  const sidIndex =
    source.indexOf(`sid       = "${sid}"`) >= 0
      ? source.indexOf(`sid       = "${sid}"`)
      : source.indexOf(`sid = "${sid}"`);
  expect(sidIndex).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('dynamic "statement" {', sidIndex);
  const end = source.indexOf('\n  dynamic "statement"', sidIndex);
  return source.slice(start, end < 0 ? undefined : end);
};

test("provisions an IAM-invoked OAuth refresh Lambda without an HTTP route", () => {
  const refresh = terraformResourceBody(
    providerRuntimeFunctions,
    "aws_lambda_function",
    "oauth_refresh",
  );
  expect(refresh).toContain('handler           = "oauth-refresh.handler"');
  expect(refresh).toContain("timeout           = 30");
  expect(refresh).toContain('role              = aws_iam_role.runtime["oauth-refresh"].arn');
  for (const env of [
    "DEPLOYMENTS_AI_CONTROL_TABLE",
    "DEPLOYMENTS_AI_EVENTS_TABLE",
    "DEPLOYMENTS_AI_EXECUTION_TABLE",
    "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN",
    "PLATFORM_OAUTH_APPS_JSON",
  ]) {
    expect(refresh).toContain(env);
  }
  expect(refresh).toMatch(
    /DEPLOYMENTS_AI_CREDENTIAL_VAULT_WRITER_ROLE_ARN = aws_iam_role\.credential_vault\["writer"\]\.arn/u,
  );
  expect(refresh).toMatch(/PLATFORM_OAUTH_PUBLIC_ORIGIN\s+= local\.public_origin/u);
  expect(providerGateway).not.toContain("aws_lambda_function.oauth_refresh.invoke_arn");
  expect(providerGateway).toContain(
    '"oauth-refresh"   = aws_lambda_function.oauth_refresh.function_name',
  );
  expect(providerRuntime).toContain('writer = ["credential-api", "oauth-api", "oauth-refresh"]');
  for (const output of [
    "oauth_refresh_function_name",
    "oauth_refresh_function_arn",
    "oauth_public_origin",
  ]) {
    expect(providerOutputs).toContain(`output "${output}"`);
  }
});

test("allowlists OAuth callback return origins for browser-facing OAuth functions", () => {
  const returnOrigins =
    /PLATFORM_OAUTH_RETURN_ORIGINS\s*=\s*join\(\s*",",\s*var\.oauth_return_origins\s*\)/u;
  expect(
    terraformResourceBody(providerRuntimeFunctions, "aws_lambda_function", "oauth_api"),
  ).toMatch(returnOrigins);
  expect(
    terraformResourceBody(providerRuntimeFunctions, "aws_lambda_function", "oauth_refresh"),
  ).not.toMatch(returnOrigins);
  expect(platformApiFunction).toMatch(returnOrigins);
  expect(stackComposition).toMatch(
    /oauth_return_origins\s*=\s*distinct\(concat\(var\.channel_provider_oauth_return_origins, var\.console_enabled \? \[var\.platform_identity_application_origin\] : \[\]\)\)/u,
  );
  expect(
    stackComposition.match(/oauth_return_origins\s*=\s*local\.oauth_return_origins/gu),
  ).toHaveLength(2);
});

test("gives the console the channel API origin that serves OAuth callbacks", () => {
  const stackConsole = readFileSync("infrastructure/modules/platform/console.tf", "utf8");
  const consoleModule = readFileSync("infrastructure/modules/console/main.tf", "utf8");
  expect(stackConsole).toMatch(
    /oauth_callback_origin\s*=\s*one\(module\.channel_provider_runtime\[\*\]\.oauth_public_origin\)/u,
  );
  expect(terraformResourceBody(consoleModule, "aws_lambda_function", "console")).toMatch(
    /CONSOLE_OAUTH_CALLBACK_ORIGIN\s*=\s*var\.oauth_callback_origin/u,
  );
});

test("scopes OAuth refresh claim writes to tenant environment partitions", () => {
  const claims = dynamicStatement(providerRuntime, "CoordinateOAuthRefreshClaims");
  expect(claims).toContain('contains(["oauth-api", "oauth-refresh"], each.key)');
  expect(claims).toContain("resources = [var.execution_table_arn]");
  expect(claims).toContain('values   = ["ORG#*#ENV#*"]');
  expect(claims).not.toContain("dynamodb:Query");
  expect(claims).not.toContain("dynamodb:Scan");
});

test("grants both OAuth refreshers every key the claim transactions touch", async () => {
  const accesses: { action: string; pk: string; table: string }[] = [];
  const stored = new Map<string, unknown>();
  const itemKey = (table: string, record: { pk: unknown; sk?: unknown }) =>
    `${table} ${String(record.pk)} ${String(record.sk)}`;
  const fakeClient = {
    send: async (command: object) => {
      const input: unknown = "input" in command ? command.input : undefined;
      if (!input || typeof input !== "object") return {};
      if (!("TransactItems" in input) || !Array.isArray(input.TransactItems)) {
        if (!("Key" in input) || !input.Key || typeof input.Key !== "object") return {};
        if (!("pk" in input.Key)) return {};
        const table = "TableName" in input ? String(input.TableName) : "";
        accesses.push({ action: "GetItem", pk: String(input.Key.pk), table });
        const item = stored.get(itemKey(table, input.Key));
        return item ? { Item: item } : {};
      }
      for (const item of input.TransactItems)
        for (const [kind, body] of Object.entries(item)) {
          if (!body || typeof body !== "object") continue;
          const record = "Item" in body ? body.Item : "Key" in body ? body.Key : undefined;
          if (!record || typeof record !== "object" || !("pk" in record)) continue;
          const table = "TableName" in body ? String(body.TableName) : "";
          if (kind === "Put") stored.set(itemKey(table, record), record);
          if (kind === "Delete") stored.delete(itemKey(table, record));
          accesses.push({
            action: kind === "ConditionCheck" ? "ConditionCheckItem" : `${kind}Item`,
            pk: String(record.pk),
            table,
          });
        }
      return {};
    },
  };
  // Captures every key the claim persistence reads or writes through packages/db.
  const client = fakeClient as unknown as Parameters<typeof makeDynamoDatabase>[0];
  const target: OAuthRefreshClaimTarget = {
    connectionId: "01J00000000000000000000001" as Ulid,
    credentialGeneration: 1,
    environmentId: "01J00000000000000000000002" as Ulid,
    organizationId: "01J00000000000000000000003" as Ulid,
    owner: "refresher",
    projectId: "01J00000000000000000000004" as Ulid,
  };
  const claims = makeOAuthRefreshClaimPersistence(makeDynamoDatabase(client));
  await claims.acquire({ ...target, leaseMs: 1_000, now: new Date() });
  await claims.release(target);
  expect(
    accesses
      .filter(({ pk }) => pk.startsWith("ORG#01J00000000000000000000003#GOVERNANCE-INVENTORY"))
      .map(({ action, pk, table }) => `${action} ${table} ${pk}`)
      .toSorted(),
  ).toEqual([
    "DeleteItem control ORG#01J00000000000000000000003#GOVERNANCE-INVENTORY",
    "PutItem control ORG#01J00000000000000000000003#GOVERNANCE-INVENTORY",
  ]);
  expect(accesses.filter(({ pk }) => pk.startsWith("GLOBAL#"))).toEqual([
    { action: "GetItem", pk: "GLOBAL#deploy-migration", table: "control" },
  ]);
  const blocks = providerRuntime
    .slice(providerRuntime.indexOf('data "aws_iam_policy_document" "runtime"'))
    .split('\n  dynamic "statement" {')
    .slice(1)
    .map((block) => block.split("\n  }\n")[0] ?? "");
  for (const role of ["oauth-api", "oauth-refresh"])
    for (const access of accesses) {
      const granted = blocks.some((block) => {
        const globs = [
          ...(block.match(/values\s+= \[([^\]]*)\]/u)?.[1] ?? "").matchAll(/"([^"]+)"/gu),
        ].map(
          (match) =>
            new RegExp(
              `^${(match[1] ?? "").replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`,
              "u",
            ),
        );
        return (
          block.includes(`"${role}"`) &&
          block.includes(`"dynamodb:${access.action}"`) &&
          block.includes(`var.${access.table}_table_arn]`) &&
          globs.some((glob) => glob.test(access.pk))
        );
      });
      expect({ role, ...access, granted }).toEqual({ role, ...access, granted: true });
    }
});

test("lets both credential vault sessions read the governance inventory layout marker", () => {
  const markerRead = [
    "  statement {",
    '    sid       = "ReadGovernanceInventoryLayout"',
    '    actions   = ["dynamodb:GetItem"]',
    "    resources = [var.control_table_arn]",
    "    condition {",
    '      test     = "ForAllValues:StringEquals"',
    '      variable = "dynamodb:LeadingKeys"',
    `      values   = ["${GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER.pk}"]`,
    "    }",
    "  }",
  ].join("\n");
  for (const document of ["credential_reader", "credential_writer"])
    expect(
      terraformResourceBody(providerRuntime, "aws_iam_policy_document", document, "data"),
    ).toContain(markerRead);
});

test("keeps human principal reads off the IAM-invoked refresh role", () => {
  const identity = dynamicStatement(providerRuntime, "AuthorizePlatformIdentity");
  expect(identity).toContain('each.key != "oauth-refresh"');
});

test("serves the OAuth client metadata document publicly from oauth-api", () => {
  const route = terraformResourceBody(
    providerGateway,
    "aws_apigatewayv2_route",
    "oauth_client_metadata",
  );
  expect(route).toContain(
    'route_key = "GET /public/provider-connections/oauth/client-metadata.json"',
  );
  expect(route).toContain("aws_apigatewayv2_integration.oauth_api.id");
  expect(route).not.toContain("authorizer_id");
  const oauthApi = terraformResourceBody(
    providerRuntimeFunctions,
    "aws_lambda_function",
    "oauth_api",
  );
  expect(oauthApi).toMatch(/PLATFORM_OAUTH_PUBLIC_ORIGIN\s+= local\.public_origin/u);
});

test("lets only the platform API and agent workers invoke the exact refresh function", () => {
  for (const source of [platformApiPolicy, agentRuntime]) {
    const invoke = dynamicStatement(source, "InvokeOAuthRefresh");
    expect(invoke).toContain('actions   = ["lambda:InvokeFunction"]');
    expect(invoke).toContain("resources = [var.oauth_refresh_function_arn]");
    expect(invoke).toContain('trimspace(var.oauth_refresh_function_arn) == "" ? [] : [1]');
  }
  // lambda-main rejects a public origin without the refresh function, so both share one block.
  expect(platformApiFunction).toMatch(
    /trimspace\(var\.oauth_public_origin\) == "" \? \{\} : \{\n\s+DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME = var\.oauth_refresh_function_name\n\s+PLATFORM_OAUTH_PUBLIC_ORIGIN\s+= var\.oauth_public_origin\n\s+\}/u,
  );
  expect(platformApiFunction).toContain(
    "oauth_public_origin, oauth_refresh_function_name, and oauth_refresh_function_arn must be configured together.",
  );
  expect(agentRuntime).toContain(
    "DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME = var.oauth_refresh_function_name",
  );
  expect(stackComposition).toMatch(
    /oauth_public_origin\s+= one\(module\.channel_provider_runtime\[\*\]\.oauth_public_origin\)/u,
  );
  expect(
    stackComposition.match(
      /oauth_refresh_function_arn\s+= one\(module\.channel_provider_runtime\[\*\]\.oauth_refresh_function_arn\)/gu,
    ),
  ).toHaveLength(2);
});
