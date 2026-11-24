import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

function block(source: string, header: string) {
  const start = source.indexOf(`${header} {\n`);
  if (start < 0) throw new Error(`OpenTofu block ${header} was not found.`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

function statement(source: string, sid: string) {
  const body = source.match(
    new RegExp(`statement \\{\\s+sid\\s+= "${sid}"(?<body>[\\s\\S]*?)\\n  \\}`, "u"),
  )?.groups?.body;
  if (body === undefined) throw new Error(`IAM statement ${sid} was not found.`);
  return body;
}

const agentRuntime = read("infrastructure/modules/agent-runtime/main.tf");
const agentRuntimeModule = block(
  read("infrastructure/modules/platform/agent-runtime.tf"),
  'module "agent_runtime"',
);
const inboundRuntime = read("infrastructure/modules/inbound-runtime/main.tf");
const platformChannels = read("infrastructure/modules/platform/events-and-channels.tf");
const platformApiWiring = read("infrastructure/modules/platform/identity-and-api.tf");
const governanceRuntime = read("infrastructure/modules/platform-api/governance-runtime.tf");
const governanceIam = read("infrastructure/modules/platform-api/governance-worker-iam.tf");
const localMain = read("infrastructure/environments/local/main.tf");
const localOutputs = read("infrastructure/environments/local/outputs.tf");
const SUBJECT_KEY_ENV = "DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN";

describe("end-user subject key", () => {
  test("is a generated SecureString long enough for the subject HMAC", () => {
    for (const variant of ["protected", "unprotected"]) {
      const password = block(
        agentRuntime,
        `resource "random_password" "end_user_subject_${variant}"`,
      );
      const length = Number(password.match(/length\s+=\s+(\d+)/u)?.[1]);
      expect(length).toBeGreaterThanOrEqual(32);
    }
    const parameter = block(agentRuntime, 'resource "aws_ssm_parameter" "end_user_subject"');
    expect(parameter).toMatch(/type\s+= "SecureString"/u);
    expect(parameter).toMatch(
      /value\s+= one\(concat\(random_password\.end_user_subject_unprotected\[\*\]\.result, random_password\.end_user_subject_protected\[\*\]\.result\)\)/u,
    );
  });

  test("survives replacement wherever deletion protection is on", () => {
    expect(block(agentRuntime, 'resource "random_password" "end_user_subject_protected"')).toMatch(
      /count\s+= var\.deletion_protection_enabled \? 1 : 0[\s\S]*lifecycle \{ prevent_destroy = true \}/u,
    );
    expect(
      block(agentRuntime, 'resource "random_password" "end_user_subject_unprotected"'),
    ).toMatch(/count\s+= var\.deletion_protection_enabled \? 0 : 1/u);
    expect(agentRuntimeModule).toMatch(
      /deletion_protection_enabled\s+= var\.operations\.deletion_protection\n/u,
    );
  });

  test("runtime-api receives the key and its role may read it", () => {
    expect(agentRuntime).toMatch(
      new RegExp(`${SUBJECT_KEY_ENV}\\s+= aws_ssm_parameter\\.end_user_subject\\.arn`, "u"),
    );
    expect(statement(agentRuntime, "RuntimeParameters")).toContain(
      "aws_ssm_parameter.end_user_subject.arn",
    );
  });

  test("every channel ingress consumer Lambda gets each variable its entry point requires", () => {
    const required = [
      ...read("functions/channel-provider-runtime/src/ingress-consumer-main.ts").matchAll(
        /= "(DEPLOYMENTS_AI_[A-Z_]+)";/gu,
      ),
    ].map((match) => match[1]!);
    expect(required).toContain(SUBJECT_KEY_ENV);
    const sharedEnvironment = block(inboundRuntime, "locals");
    const consumers = ["runtime", "flush"].map((name) =>
      block(inboundRuntime, `resource "aws_lambda_function" "${name}"`),
    );
    for (const consumer of consumers) {
      expect(consumer).toContain('handler           = "ingress-consumer-main.handler"');
      expect(consumer).toContain("local.runtime_environment");
      for (const name of required) expect(`${consumer}${sharedEnvironment}`).toContain(name);
    }
    expect(statement(inboundRuntime, "ReadEndUserSubjectKey")).toMatch(
      /actions\s+= \["ssm:GetParameter"\]\s+resources = \[var\.end_user_subject_key_arn\]/u,
    );
    expect(platformChannels).toMatch(
      /end_user_subject_key_arn\s+= module\.agent_runtime\[0\]\.end_user_subject_key_arn/u,
    );
  });

  test("local processes read the key from a seeded local secret", () => {
    expect(localMain).toContain('"end-user-subject-key"');
    expect(
      block(localMain, 'resource "aws_secretsmanager_secret_version" "end_user_subject"'),
    ).toContain("random_password.end_user_subject.result");
    expect(localOutputs).toMatch(
      new RegExp(
        `${SUBJECT_KEY_ENV}\\s+= aws_secretsmanager_secret\\.runtime\\["end-user-subject-key"\\]\\.arn`,
        "u",
      ),
    );
  });
});

describe("governance worker for conversation erasure", () => {
  const worker = block(governanceRuntime, 'resource "aws_lambda_function" "governance_worker"');

  test("receives the durable streams endpoint, its token, and the automation scheduler group", () => {
    expect(worker).toMatch(
      /DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN = var\.durable_streams_auth_secret_arn/u,
    );
    expect(worker).toMatch(/DEPLOYMENTS_AI_DURABLE_STREAMS_URL\s+= var\.durable_streams_base_url/u);
    expect(worker).toMatch(
      /DEPLOYMENTS_AI_SCHEDULER_GROUP\s+= var\.automation_scheduler_group_name/u,
    );
    expect(platformApiWiring).toMatch(
      /durable_streams_auth_secret_arn\s+= module\.durable_streams\[0\]\.auth_token_secret_arn/u,
    );
    expect(platformApiWiring).toMatch(
      /durable_streams_base_url\s+= module\.durable_streams\[0\]\.base_url/u,
    );
    expect(platformApiWiring).toMatch(
      /automation_scheduler_group_name\s+= module\.agent_runtime\[0\]\.scheduler_group_name/u,
    );
  });

  test("runs in the VPC that alone reaches durable streams", () => {
    expect(worker).toContain('dynamic "vpc_config"');
    expect(worker).toContain("aws_security_group.governance_worker[0].id");
    expect(governanceIam).toMatch(
      /for_each = var\.network == null \? \[\] : \[1\]\s+content \{\s+sid = "VpcNetworking"\s+actions = \[\s+"ec2:CreateNetworkInterface"/u,
    );
  });

  test("may read the stream token and only delete automation timers", () => {
    expect(statement(governanceIam, "ReadDurableStreamsToken")).toMatch(
      /actions\s+= \["ssm:GetParameter"\]\s+resources = \[var\.durable_streams_auth_secret_arn\]/u,
    );
    const timers = statement(governanceIam, "DeleteErasedThreadTimers");
    expect(timers).toMatch(/actions\s+= \["scheduler:DeleteSchedule"\]/u);
    expect(timers).toContain(":schedule/${var.automation_scheduler_group_name}/*");
    expect(governanceIam).not.toContain("scheduler:CreateSchedule");
    expect(governanceIam).not.toContain("scheduler:UpdateSchedule");
    expect(governanceIam).not.toContain("iam:PassRole");
  });
});
