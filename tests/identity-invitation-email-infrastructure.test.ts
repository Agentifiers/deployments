import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const apiPolicy = readFileSync("infrastructure/modules/platform-api/api-iam.tf", "utf8");
const apiFunction = readFileSync(
  "infrastructure/modules/platform-api/governance-runtime.tf",
  "utf8",
);
const identity = readFileSync("infrastructure/modules/platform-identity/main.tf", "utf8");
const stack = readFileSync("infrastructure/modules/platform/identity-and-api.tf", "utf8");

function dynamicStatement(sid: string) {
  return apiPolicy.match(
    new RegExp(
      `dynamic "statement" \\{\\s+for_each = (?<gate>[^\\n]+)\\n\\s+content \\{\\s+sid\\s+= "${sid}"(?<body>[\\s\\S]*?)\\n  \\}`,
      "u",
    ),
  )?.groups;
}

describe("organization invitation email infrastructure", () => {
  test("lets the API enqueue invitation email only to the outbox under the email key", () => {
    const outbox = dynamicStatement("QueueOrganizationInvitationEmail");
    const key = dynamicStatement("ProtectOrganizationInvitationEmail");
    for (const statement of [outbox, key]) {
      expect(statement?.gate).toBe('trimspace(var.identity_email_kms_key_arn) == "" ? [] : [1]');
    }
    expect(outbox?.body).toContain('"dynamodb:TransactWriteItems"');
    expect(outbox?.body).toContain('"dynamodb:ConditionCheckItem"');
    expect(outbox?.body).not.toContain("dynamodb:Query");
    expect(outbox?.body).toContain("resources = [var.identity_email_table_arn]");
    expect(key?.body).toContain('actions   = ["kms:GenerateDataKey"]');
    expect(key?.body).not.toContain("kms:Decrypt");
    expect(key?.body).toContain("resources = [var.identity_email_kms_key_arn]");
  });

  test("configures the API runtime only when platform identity is deployed", () => {
    expect(apiFunction).toMatch(
      /trimspace\(var\.identity_email_kms_key_arn\) == "" \? \{\} : \{\n\s+DEPLOYMENTS_AI_IDENTITY_EMAIL_OUTBOX_TABLE = var\.identity_email_table_name\n/u,
    );
    expect(apiFunction).toMatch(
      /trimspace\(var\.identity_email_kms_key_arn\) == "" \? \{\} : \{\n\s+DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID\s+= var\.identity_email_kms_key_arn\n\s+DEPLOYMENTS_AI_STAGE\s+= var\.environment\n/u,
    );
    expect(stack).toContain(
      'identity_email_kms_key_arn                 = var.platform_identity_enabled ? module.platform_data.kms_key_arn : ""',
    );
  });

  test("gives the email worker the application origin for invitation links", () => {
    const worker = identity.match(
      /resource "aws_lambda_function" "worker" \{(?<body>[\s\S]*?)\n\}/u,
    )?.groups?.body;
    expect(worker).toMatch(
      /DEPLOYMENTS_AI_IDENTITY_APPLICATION_ORIGIN\s+= var\.application_origin/u,
    );
  });
});
