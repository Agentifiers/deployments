import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { LIMITS } from "../functions/document-extraction/src/limits.ts";
import { EXTRACTION_DEADLINE_MS } from "../packages/file-text/src/wire.ts";
import { deploymentArtifacts } from "../scripts/build-deployment-artifacts.ts";
import { buildReleaseVariables } from "../scripts/platform-deploy/lambda-artifacts.ts";

const read = (path: string) => readFileSync(path, "utf8");

function terraformFiles(directory: string): string[] {
  return readdirSync(directory)
    .toSorted()
    .flatMap((entry) => {
      if (entry.startsWith(".")) return [];
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return terraformFiles(path);
      return path.endsWith(".tf") ? [path] : [];
    });
}

const extraction = terraformFiles("infrastructure/modules/document-extraction")
  .map(read)
  .join("\n");
const extractionVariables = read("infrastructure/modules/document-extraction/variables.tf");
const extractionOutputs = read("infrastructure/modules/document-extraction/outputs.tf");
const stackExtraction = read("infrastructure/modules/platform/document-extraction.tf");
const network = read("infrastructure/modules/network/main.tf");
const networkOutputs = read("infrastructure/modules/network/outputs.tf");
const allTerraform = terraformFiles("infrastructure").map((path) => ({ path, source: read(path) }));

function balanced(source: string, start: number): string {
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated block at ${start}`);
}

function block(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start === -1) throw new Error(`Missing ${opener}`);
  return balanced(source, start);
}

const resource = (source: string, type: string, name: string) =>
  block(source, `resource "${type}" "${name}" {`);

function attributes(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/^ {2}([a-z_]+)\s+= (.+)$/gmu)].map((match) => [match[1]!, match[2]!]),
  );
}

test("runs on arm64 Node 26 and leaves concurrency unreserved", () => {
  const extractor = resource(extraction, "aws_lambda_function", "document_extraction");
  const fields = attributes(extractor);
  expect(fields).toMatchObject({
    architectures: '["arm64"]',
    function_name: '"document-extraction"',
    handler: '"handler.handler"',
    memory_size: "2048",
    runtime: '"nodejs26.x"',
    timeout: "120",
  });
  expect(Object.keys(fields)).not.toContain("reserved_concurrent_executions");
  expect(extractor).toContain("ignore_changes = [s3_bucket, s3_key, s3_object_version]");
});

test("fits the longest extraction deadline and the source fetch inside the function timeout", () => {
  const timeoutSeconds = Number(
    attributes(resource(extraction, "aws_lambda_function", "document_extraction")).timeout,
  );
  expect(EXTRACTION_DEADLINE_MS.max + LIMITS.sourceFetchTimeoutMs).toBeLessThan(
    timeoutSeconds * 1_000,
  );
});

test("lets the function reach only S3 through the gateway endpoint and, with OCR, the Textract endpoint, over HTTPS", () => {
  const group = resource(extraction, "aws_security_group", "document_extraction");
  expect(attributes(group)).toMatchObject({
    count: "var.network == null ? 0 : 1",
    vpc_id: "var.network.vpc_id",
  });
  const endpointGroup = resource(extraction, "aws_security_group", "textract_endpoint");
  expect(attributes(endpointGroup)).toMatchObject({
    count: "local.textract_endpoint_count",
    vpc_id: "var.network.vpc_id",
  });
  for (const securityGroup of [group, endpointGroup]) {
    expect(securityGroup).not.toMatch(/\b(ingress|egress)\s*(\{|=)/u);
  }
  expect(extraction.match(/resource "aws_security_group" /gu)).toHaveLength(2);

  const egressRules = [
    ...extraction.matchAll(/resource "aws_vpc_security_group_egress_rule" "([a-z0-9_]+)" \{/gu),
  ].map((match) =>
    attributes(resource(extraction, "aws_vpc_security_group_egress_rule", match[1]!)),
  );
  expect(egressRules).toEqual([
    {
      count: "var.network == null ? 0 : 1",
      from_port: "443",
      ip_protocol: '"tcp"',
      prefix_list_id: "var.network.s3_prefix_list_id",
      security_group_id: "aws_security_group.document_extraction[0].id",
      tags: "local.common_tags",
      to_port: "443",
    },
    {
      count: "local.textract_endpoint_count",
      from_port: "443",
      ip_protocol: '"tcp"',
      referenced_security_group_id: "aws_security_group.textract_endpoint[0].id",
      security_group_id: "aws_security_group.document_extraction[0].id",
      tags: "local.common_tags",
      to_port: "443",
    },
  ]);

  const ingressRules = [
    ...extraction.matchAll(/resource "aws_vpc_security_group_ingress_rule" "([a-z0-9_]+)" \{/gu),
  ].map((match) => match[1]);
  expect(ingressRules).toEqual(["textract_endpoint_from_extraction"]);
  const ingress = resource(
    extraction,
    "aws_vpc_security_group_ingress_rule",
    "textract_endpoint_from_extraction",
  );
  expect(attributes(ingress)).toEqual({
    count: "local.textract_endpoint_count",
    from_port: "443",
    ip_protocol: '"tcp"',
    referenced_security_group_id: "aws_security_group.document_extraction[0].id",
    security_group_id: "aws_security_group.textract_endpoint[0].id",
    tags: "local.common_tags",
    to_port: "443",
  });
  expect(extraction.replace(ingress, "")).not.toContain("ingress");
  expect([...extractionOutputs.matchAll(/output "([a-z_]+)"/gu)].map((match) => match[1])).toEqual([
    "function_arn",
    "function_name",
  ]);

  const placement = block(
    resource(extraction, "aws_lambda_function", "document_extraction"),
    'dynamic "vpc_config" {',
  );
  expect(placement).toContain("for_each = var.network == null ? [] : [var.network]");
  expect(placement).toContain(
    "security_group_ids = [aws_security_group.document_extraction[0].id]",
  );
  expect(placement).toMatch(/subnet_ids\s+= vpc_config\.value\.private_subnet_ids/u);

  expect(networkOutputs).toContain("value       = aws_vpc_endpoint.s3.prefix_list_id");
  expect(attributes(resource(network, "aws_vpc_endpoint", "s3"))).toMatchObject({
    route_table_ids: "[for table in aws_route_table.private : table.id]",
    vpc_endpoint_type: '"Gateway"',
  });
  expect(attributes(resource(network, "aws_route_table_association", "private"))).toEqual({
    for_each: "aws_subnet.private",
    route_table_id: "aws_route_table.private[each.key].id",
    subnet_id: "each.value.id",
  });
});

test("grants the role only its own log group, inside the VPC network interfaces, and with OCR text detection", () => {
  const policy = block(extraction, 'data "aws_iam_policy_document" "document_extraction" {');
  expect([...policy.matchAll(/sid\s+= "([A-Za-z]+)"/gu)].map((match) => match[1])).toEqual([
    "WriteOwnLogs",
    "VpcNetworking",
    "RecognizeScannedPages",
  ]);
  expect(block(policy, "statement {")).toMatch(
    /actions\s+= \["logs:CreateLogStream", "logs:PutLogEvents"\]\n\s+resources = \["\$\{aws_cloudwatch_log_group\.document_extraction\.arn\}:\*"\]/u,
  );
  const networking = block(policy, 'dynamic "statement" {');
  expect(networking).toContain("for_each = var.network == null ? [] : [1]");
  expect([...networking.matchAll(/"(ec2:[A-Za-z]+)"/gu)].map((match) => match[1])).toEqual([
    "ec2:AssignPrivateIpAddresses",
    "ec2:CreateNetworkInterface",
    "ec2:DeleteNetworkInterface",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeSubnets",
    "ec2:UnassignPrivateIpAddresses",
  ]);

  const recognition = balanced(policy, policy.lastIndexOf('dynamic "statement" {'));
  expect(recognition).toContain("for_each = var.ocr_enabled ? [1] : []");
  expect(recognition).toContain('sid       = "RecognizeScannedPages"');
  expect(recognition).toMatch(/actions\s+= \["textract:DetectDocumentText"\]\n/u);
  expect(recognition).toMatch(/resources = \["\*"\]/u);
  expect([...recognition.matchAll(/condition \{/gu)]).toHaveLength(1);
  expect(block(recognition, "condition {")).toMatch(
    /test\s+= "StringEquals"\n\s+variable = "aws:RequestedRegion"\n\s+values\s+= \[data\.aws_region\.current\.region\]/u,
  );
  expect([...extraction.matchAll(/"textract:([A-Za-z*]+)"/gu)].map((match) => match[1])).toEqual([
    "DetectDocumentText",
    "DetectDocumentText",
  ]);

  expect(extraction.match(/resource "aws_iam_role_policy" /gu)).toHaveLength(1);
  for (const forbidden of [
    '"s3:',
    '"kms:',
    '"dynamodb:',
    '"secretsmanager:',
    '"ssm:',
    '"lambda:',
    '"textract:Start',
    '"textract:Analyze',
    '"textract:Get',
    "aws_iam_role_policy_attachment",
    "managed_policy_arns",
  ]) {
    expect(extraction).not.toContain(forbidden);
  }
});

test("joins the platform network exactly where the agent runtime creates it", () => {
  const instance = block(stackExtraction, 'module "document_extraction" {');
  expect(Object.keys(attributes(instance))).not.toContain("count");
  expect(instance).toMatch(
    /network = var\.agent_runtime_enabled \? \{\n\s+private_subnet_ids = module\.platform_network\[0\]\.private_subnet_ids\n\s+s3_prefix_list_id\s+= module\.platform_network\[0\]\.s3_prefix_list_id\n\s+vpc_id\s+= module\.platform_network\[0\]\.vpc_id\n\s+\} : null/u,
  );
  expect(block(extractionVariables, 'variable "network" {')).toMatch(
    /type = object\(\{\n\s+private_subnet_ids = list\(string\)\n\s+s3_prefix_list_id\s+= string\n\s+vpc_id\s+= string\n\s+\}\)/u,
  );
});

test("reaches Textract only through a role-locked interface endpoint, and only when OCR is on", () => {
  expect(extraction).toMatch(
    /\n\s+textract_endpoint_count\s+= var\.ocr_enabled && var\.network != null \? 1 : 0\n/u,
  );
  expect(extraction).toMatch(
    /\n\s+textract_endpoint_url\s+= var\.ocr_enabled \? "https:\/\/\$\{data\.aws_vpc_endpoint_service\.textract\[0\]\.private_dns_name\}" : null\n/u,
  );
  expect(attributes(block(extraction, 'data "aws_vpc_endpoint_service" "textract" {'))).toEqual({
    count: "var.ocr_enabled ? 1 : 0",
    service: '"textract"',
    service_type: '"Interface"',
  });

  expect(extraction.match(/resource "aws_vpc_endpoint" /gu)).toHaveLength(1);
  expect(attributes(resource(extraction, "aws_vpc_endpoint", "textract"))).toEqual({
    count: "local.textract_endpoint_count",
    policy: "data.aws_iam_policy_document.textract_endpoint[0].json",
    private_dns_enabled: "true",
    security_group_ids: "[aws_security_group.textract_endpoint[0].id]",
    service_name: "data.aws_vpc_endpoint_service.textract[0].service_name",
    subnet_ids: "var.network.private_subnet_ids",
    tags: 'merge(local.common_tags, { Name = "document-extraction-textract" })',
    vpc_endpoint_type: '"Interface"',
    vpc_id: "var.network.vpc_id",
  });
  const endpointPolicy = block(extraction, 'data "aws_iam_policy_document" "textract_endpoint" {');
  expect(endpointPolicy).toMatch(/actions\s+= \["textract:DetectDocumentText"\]\n/u);
  expect(block(endpointPolicy, "condition {")).toMatch(
    /test\s+= "ArnEquals"\n\s+variable = "aws:PrincipalArn"\n\s+values\s+= \[aws_iam_role\.document_extraction\.arn\]/u,
  );

  const extractor = resource(extraction, "aws_lambda_function", "document_extraction");
  const environment = block(extractor, 'dynamic "environment" {');
  expect(environment).toBe(
    [
      'dynamic "environment" {',
      "    for_each = local.textract_endpoint_url == null ? [] : [local.textract_endpoint_url]",
      "    content {",
      "      variables = { DEPLOYMENTS_AI_TEXTRACT_ENDPOINT = environment.value }",
      "    }",
      "  }",
    ].join("\n"),
  );
  expect(extractor.replace(environment, "")).not.toContain("environment");

  expect(block(extractionVariables, 'variable "ocr_enabled" {')).not.toContain("default");
  expect(
    block(
      read("infrastructure/modules/platform/variables-document-extraction.tf"),
      'variable "document_extraction_ocr_enabled" {',
    ),
  ).not.toContain("default");
  expect(attributes(block(stackExtraction, 'module "document_extraction" {'))).toMatchObject({
    ocr_enabled: "var.document_extraction_ocr_enabled",
  });
  const root = terraformFiles("infrastructure/environments/customer").map(read).join("\n");
  expect(block(root, 'module "platform" {')).toMatch(
    /\n\s+document_extraction_ocr_enabled\s+= var\.document_extraction_ocr_enabled\n/u,
  );
  expect(block(root, 'variable "document_extraction_ocr_enabled" {')).toMatch(
    /type\s+= bool\n\s+default\s+= false\n/u,
  );
});

test("grants invoke only to the named callers", () => {
  const invokeGrants = allTerraform.flatMap(({ path, source }) =>
    [...source.matchAll(/"lambda:InvokeFunction"/gu)].map((match) => {
      let start = match.index;
      for (let depth = 0; depth >= 0; ) {
        start -= 1;
        if (source[start] === "}") depth += 1;
        if (source[start] === "{") depth -= 1;
      }
      return { grant: balanced(source, start), path };
    }),
  );
  expect(invokeGrants.some(({ grant }) => grant.includes("[var.oauth_refresh_function_arn]"))).toBe(
    true,
  );
  expect(
    invokeGrants.filter(({ grant }) => /resources\s+= \["\*"\]|:function:\*/u.test(grant)),
  ).toEqual([]);
  expect(
    invokeGrants
      .filter(({ grant }) => /document.extraction/u.test(grant))
      .map(({ grant, path }) => `${path}: ${/sid\s+= "([A-Za-z]+)"/u.exec(grant)?.[1]}`)
      .toSorted(),
  ).toEqual([
    "infrastructure/modules/agent-email/runtime.tf: InvokeDocumentExtraction",
    "infrastructure/modules/agent-runtime/main.tf: InvokeDocumentExtraction",
    "infrastructure/modules/brain-runtime/main.tf: InvokeDocumentExtraction",
    "infrastructure/modules/inbound-runtime/main.tf: InvokeDocumentExtraction",
  ]);
  expect(
    allTerraform
      .filter(({ source }) => source.includes("module.document_extraction."))
      .map(({ path }) => path)
      .toSorted(),
  ).toEqual([
    "infrastructure/modules/platform/agent-runtime.tf",
    "infrastructure/modules/platform/events-and-channels.tf",
    "infrastructure/modules/platform/memory-and-brain.tf",
  ]);
});

test("passes every published release artifact through both environment roots", () => {
  const variables = buildReleaseVariables(
    "artifact-bucket",
    Object.fromEntries(
      Object.keys(deploymentArtifacts).map((name) => [
        name,
        { key: `${name}/digest.zip`, version: `${name}-version` },
      ]),
    ) as Parameters<typeof buildReleaseVariables>[1],
  );
  expect(variables).toMatchObject({
    document_extraction_artifact_bucket: "artifact-bucket",
    document_extraction_artifact_key: "document-extraction/digest.zip",
    document_extraction_artifact_version: "document-extraction-version",
  });

  const root = terraformFiles("infrastructure/environments/customer").map(read).join("\n");
  const platform = block(root, 'module "platform" {');
  for (const name of Object.keys(variables)) {
    expect(root).toContain(`variable "${name}" {`);
    expect(platform).toMatch(new RegExp(`\\n\\s+${name}\\s+= var\\.${name}\\n`, "u"));
  }
  expect(attributes(block(stackExtraction, 'module "document_extraction" {'))).toMatchObject({
    artifact_bucket: "var.document_extraction_artifact_bucket",
    artifact_key: "var.document_extraction_artifact_key",
    artifact_version: "var.document_extraction_artifact_version",
  });
});
