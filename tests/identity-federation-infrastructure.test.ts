import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDENTITY_PROVIDER_SECRET_PURPOSE } from "@deployments-ai/db";

const apiGrant = readFileSync(
  "infrastructure/modules/platform-api/identity-federation-iam.tf",
  "utf8",
);
const apiFunction = readFileSync(
  "infrastructure/modules/platform-api/governance-runtime.tf",
  "utf8",
);
const federationKey = readFileSync(
  "infrastructure/modules/platform-identity/federation-kms.tf",
  "utf8",
);
const identity = readFileSync("infrastructure/modules/platform-identity/main.tf", "utf8");
const stack = readFileSync("infrastructure/modules/platform/identity-and-api.tf", "utf8");

function topLevelBlock(source: string, header: string) {
  const block = new RegExp(`(?:^|\\n)${header} \\{(?<body>[\\s\\S]*?)\\n\\}`, "u");
  return source.match(block)?.groups?.body;
}

const purposeCondition = new RegExp(
  `condition \\{\\n\\s+test\\s+= "StringEquals"\\n\\s+variable = "kms:EncryptionContext:purpose"\\n\\s+values\\s+= \\["${IDENTITY_PROVIDER_SECRET_PURPOSE}"\\]\\n`,
  "u",
);

describe("identity federation client secret infrastructure", () => {
  test("lets the API seal client secrets under the federation key without opening them", () => {
    const statement = topLevelBlock(
      apiGrant,
      'data "aws_iam_policy_document" "identity_federation"',
    );
    const policy = topLevelBlock(apiGrant, 'resource "aws_iam_role_policy" "identity_federation"');
    expect(statement).toContain("count = var.identity_federation == null ? 0 : 1");
    expect(statement).toContain('sid       = "SealIdentityProviderClientSecrets"');
    expect(statement).toContain('actions   = ["kms:GenerateDataKey"]');
    expect(statement).not.toContain("kms:Decrypt");
    expect(statement).not.toContain('"kms:Encrypt"');
    expect(statement).toContain("resources = [var.identity_federation.kms_key_arn]");
    expect(statement).toMatch(purposeCondition);
    expect(policy).toContain("count = var.identity_federation == null ? 0 : 1");
    expect(policy).toContain("role   = aws_iam_role.lambda.id");
    expect(policy).toContain("policy = data.aws_iam_policy_document.identity_federation[0].json");
  });

  test("lets only the identity service open client secrets", () => {
    const policy = topLevelBlock(federationKey, 'resource "aws_iam_role_policy" "api_federation"');
    expect(policy).toContain("role = aws_iam_role.api.id");
    expect(policy).toContain('Action    = ["kms:Decrypt"]');
    expect(policy).not.toContain("kms:GenerateDataKey");
    expect(policy).toContain("Resource  = local.federation_key_arn");
    expect(policy).toContain(
      `Condition = { StringEquals = { "kms:EncryptionContext:purpose" = "${IDENTITY_PROVIDER_SECRET_PURPOSE}" } }`,
    );
    const sharedPolicy = topLevelBlock(identity, 'resource "aws_iam_role_policy" "api"');
    expect(sharedPolicy).toContain("Resource  = local.email_key_arn");
    expect(sharedPolicy).not.toContain("federation");
  });

  test("provisions a dedicated rotating symmetric key retained under deletion protection", () => {
    const unprotected = topLevelBlock(
      federationKey,
      'resource "aws_kms_key" "federation_unprotected"',
    );
    const protectedKey = topLevelBlock(
      federationKey,
      'resource "aws_kms_key" "federation_protected"',
    );
    for (const key of [unprotected, protectedKey]) {
      expect(key).toContain("enable_key_rotation     = true");
      expect(key).not.toContain("customer_master_key_spec");
      expect(key).not.toContain("policy");
    }
    expect(unprotected).toContain(
      "count                   = var.deletion_protection_enabled ? 0 : 1",
    );
    expect(unprotected).toContain("deletion_window_in_days = var.kms_deletion_window_in_days");
    expect(protectedKey).toContain(
      "count                   = var.deletion_protection_enabled ? 1 : 0",
    );
    expect(protectedKey).toContain("deletion_window_in_days = 30");
    expect(protectedKey).toContain("lifecycle { prevent_destroy = true }");
    expect(topLevelBlock(federationKey, 'resource "aws_kms_alias" "federation"')).toContain(
      'name          = "alias/${local.name}-federation"',
    );
  });

  test("configures both runtimes with the federation key only when platform identity is deployed", () => {
    expect(topLevelBlock(identity, 'resource "aws_lambda_function" "api"')).toMatch(
      /DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID\s+= local\.federation_key_arn\n/u,
    );
    expect(apiFunction).toMatch(
      /var\.identity_federation == null \? \{\} : \{\n\s+DEPLOYMENTS_AI_IDENTITY_FEDERATION_KMS_KEY_ID = var\.identity_federation\.kms_key_arn\n\s+DEPLOYMENTS_AI_STAGE\s+= var\.environment\n/u,
    );
    expect(stack).toContain(
      "identity_federation                        = var.platform_identity_enabled ? { kms_key_arn = module.platform_identity[0].federation_kms_key_arn } : null",
    );
  });
});
