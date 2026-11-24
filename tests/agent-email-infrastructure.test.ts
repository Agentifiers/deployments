import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS } from "../packages/ingress-media/src/index.ts";

const runtime = readFileSync("infrastructure/modules/agent-email/runtime.tf", "utf8");
const workers = readFileSync("infrastructure/modules/agent-email/workers.tf", "utf8");
const variables = readFileSync("infrastructure/modules/agent-email/variables.tf", "utf8");
const outputs = readFileSync("infrastructure/modules/agent-email/outputs.tf", "utf8");
const stackData = readFileSync("infrastructure/modules/platform/data.tf", "utf8");
const stackChannels = readFileSync(
  "infrastructure/modules/platform/events-and-channels.tf",
  "utf8",
);
const subjectKey = readFileSync(
  "infrastructure/modules/agent-email/end-user-subject-key.tf",
  "utf8",
);

function block(source: string, kind: "data" | "resource", type: string, name: string) {
  const start = source.indexOf(`${kind} "${type}" "${name}" {`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated OpenTofu ${kind} ${type}.${name}`);
}

test("lets both inbound roles reach captured attachments only through the tenant-tagged capture role and the extraction function", () => {
  const capture = block(runtime, "data", "aws_iam_policy_document", "inbound_attachment_capture");
  expect(capture).toMatch(/count = length\(local\.inbound_role_arns\) > 0 \? 1 : 0/u);
  expect(capture).toMatch(
    /sid\s+= "AssumeIngressAttachmentCapture"\s+actions\s+= \["sts:AssumeRole", "sts:TagSession"\]\s+resources = \[var\.ingress_attachment_capture_role_arn\]/u,
  );
  expect(capture).toMatch(
    /sid\s+= "InvokeDocumentExtraction"\s+actions\s+= \["lambda:InvokeFunction"\]\s+resources = \[var\.document_extraction_function\.arn\]/u,
  );
  expect(capture).not.toContain('"s3:');
  expect(capture).not.toContain('"kms:');
  for (const source of [runtime, workers, variables]) {
    expect(source).not.toContain("/customer/");
    expect(source).not.toContain("artifact_bucket_arn");
  }
  expect(block(runtime, "data", "aws_iam_policy_document", "inbound_runtime")).toContain(
    "source_policy_documents = data.aws_iam_policy_document.inbound_attachment_capture[*].json",
  );
  expect(block(workers, "data", "aws_iam_policy_document", "worker")).toContain(
    'source_policy_documents = each.key == "inbound" ? data.aws_iam_policy_document.inbound_attachment_capture[*].json : []',
  );
  expect(runtime).toMatch(
    /inbound_role_arns = concat\(\s+\[for name, role in aws_iam_role\.runtime : role\.arn if name == "inbound"\],\s+data\.aws_iam_role\.inbound_worker\[\*\]\.arn,\s+\)/u,
  );
  expect(outputs).toMatch(
    /output "inbound_role_arns" \{[^}]*value\s+= local\.inbound_role_arns\s+\}/u,
  );
  const inbound = block(runtime, "resource", "aws_lambda_function", "inbound");
  expect(inbound).toMatch(/DEPLOYMENTS_AI_ARTIFACT_BUCKET\s+= var\.artifact_bucket_name/u);
  expect(inbound).toMatch(/DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN\s+= var\.data_kms_key_arn/u);
  expect(inbound).toMatch(
    /DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN\s+= var\.ingress_attachment_capture_role_arn/u,
  );
  expect(inbound).toMatch(
    /DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME\s+= var\.document_extraction_function\.function_name/u,
  );
  expect(stackData).toMatch(
    /ingress_attachment_capture_principal_arns\s+= concat\([^)]*module\.agent_email\.inbound_role_arns,\s+\)/u,
  );
  const agentEmailModule = stackChannels.slice(stackChannels.indexOf('module "agent_email" {'));
  expect(agentEmailModule).toMatch(
    /ingress_attachment_capture_role_arn\s+= module\.platform_data\.ingress_attachment_capture_role_arn/u,
  );
  expect(agentEmailModule).toMatch(
    /document_extraction_function\s+= \{ arn = module\.document_extraction\.function_arn, function_name = module\.document_extraction\.function_name \}/u,
  );
});

test("sizes the inbound Lambda so a full batch of attachment captures fits its timeout", () => {
  const STORE_ALLOWANCE_SECONDS = 10;
  const SUBMIT_ALLOWANCE_SECONDS = 10;
  const setting = (body: string, field: string) =>
    Number(new RegExp(`${field}\\s+= (\\d+)`, "u").exec(body)?.[1]);
  const batchSize = setting(
    block(runtime, "resource", "aws_lambda_event_source_mapping", "managed_inbound"),
    "batch_size",
  );
  const timeout = setting(block(runtime, "resource", "aws_lambda_function", "inbound"), "timeout");
  const recordSeconds =
    INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS / 1_000 +
    STORE_ALLOWANCE_SECONDS +
    SUBMIT_ALLOWANCE_SECONDS;

  expect(batchSize * recordSeconds).toBeLessThanOrEqual(timeout);
});

test("gives the API and inbound Lambdas the end-user subject key they key mail correspondents with", () => {
  for (const entryPoint of ["api-main.ts", "inbound-main.ts"]) {
    expect(readFileSync(`functions/agent-email-runtime/src/${entryPoint}`, "utf8")).toContain(
      '"DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN"',
    );
  }
  for (const name of ["api", "inbound"]) {
    const lambda = block(runtime, "resource", "aws_lambda_function", name);
    expect(lambda).toMatch(
      /DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN\s+= var\.end_user_subject_key_arn/u,
    );
    expect(lambda).toContain('trimspace(var.end_user_subject_key_arn) != ""');
    expect(lambda).toContain("aws_iam_role_policy.end_user_subject_key");
  }
  expect(block(subjectKey, "data", "aws_iam_policy_document", "end_user_subject_key")).toMatch(
    /sid\s+= "ReadEndUserSubjectKey"\s+actions\s+= \["ssm:GetParameter"\]\s+resources = \[var\.end_user_subject_key_arn\]/u,
  );
  expect(block(subjectKey, "resource", "aws_iam_role_policy", "end_user_subject_key")).toContain(
    'toset(["api", "inbound"])',
  );
  expect(stackChannels.slice(stackChannels.indexOf('module "agent_email" {'))).toMatch(
    /end_user_subject_key_arn\s+= try\(module\.agent_runtime\[0\]\.end_user_subject_key_arn, ""\)/u,
  );
});
