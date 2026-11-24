import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readTerraformFiles } from "./terraform-files.ts";

const operatorPolicy = readFileSync(
  "infrastructure/modules/platform-api/system-operator.tf",
  "utf8",
).match(/data "aws_iam_policy_document" "system_operator" \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body;
const platformApi = readTerraformFiles("infrastructure/modules/platform-api", "");

describe("system operator infrastructure", () => {
  test("grants metadata reads without any value-reading permission", () => {
    expect(operatorPolicy).toBeDefined();
    for (const action of [
      "ecs:DescribeServices",
      "lambda:ListFunctions",
      "cloudwatch:DescribeAlarms",
      "ssm:DescribeParameters",
      "secretsmanager:DescribeSecret",
    ]) {
      expect(operatorPolicy).toContain(`"${action}"`);
    }
    for (const forbidden of [
      /"ssm:GetParameter/u,
      /"secretsmanager:GetSecretValue"/u,
      /"lambda:GetFunction"/u,
      /"lambda:GetFunctionConfiguration"/u,
      /"ssm:\*"|"secretsmanager:\*"|"lambda:\*"/u,
    ]) {
      expect(operatorPolicy).not.toMatch(forbidden);
    }
  });

  test("configures the API Lambdas with the operator parameter and its read grant", () => {
    expect(platformApi).toMatch(
      /DEPLOYMENTS_AI_SYSTEM_OPERATOR_PARAMETER_ARN\s+= aws_ssm_parameter\.system_operator\.arn/u,
    );
    expect(platformApi).toMatch(
      /sid\s+= "ReadSystemOperatorConfiguration"\s+actions\s+= \["ssm:GetParameter"\]\s+resources = \[aws_ssm_parameter\.system_operator\.arn\]/u,
    );
    expect(platformApi).not.toContain("DEPLOYMENTS_AI_SYSTEM_OPERATOR_JSON");
    expect(platformApi).toContain("aws_iam_role_policy_attachment.system_operator");
  });
});
