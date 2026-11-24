import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brainNormalizedTextKey } from "../packages/brains/src/text-rendition.ts";

const source = readFileSync("infrastructure/modules/brain-runtime/main.tf", "utf8");
const erasureSource = readFileSync("functions/api/src/brain/erasure-main.ts", "utf8");
const indexWorkerSource = readFileSync("functions/api/src/brain/index-worker-main.ts", "utf8");

function statement(sid: string) {
  const start = source.lastIndexOf("dynamic", source.indexOf(`"${sid}"`));
  return source.slice(start, source.indexOf("\n  }\n", start));
}

describe("Brain runtime IAM", () => {
  test("allows content maintenance to delete expired control and execution records", () => {
    expect(source).toContain('for_each = each.key == "brain-content-maintenance" ? [1] : []');
    expect(source).toContain('sid       = "DeleteExpiredBrainContentRecords"');
    expect(source).toContain('actions   = ["dynamodb:DeleteItem"]');
    expect(source).toContain(
      'resources = [var.dynamodb_table_arns["control"], var.dynamodb_table_arns["execution"]]',
    );
  });

  test("allows erasure inventory to batch-read records before deleting them", () => {
    const statement = source.slice(
      source.indexOf('sid = "InventoryAndDeleteBrainRecords"'),
      source.indexOf("  }", source.indexOf('sid = "InventoryAndDeleteBrainRecords"')),
    );
    expect(statement).toContain('"dynamodb:BatchGetItem"');
    expect(statement).toContain('"dynamodb:BatchWriteItem"');
    expect(statement).toContain('"dynamodb:DeleteItem"');
  });

  test("lets only Brain erasure delete Brain-tagged run publications", () => {
    const statement = source.slice(
      source.indexOf('sid     = "EraseBrainRunPublications"'),
      source.indexOf("    }", source.indexOf('sid     = "EraseBrainRunPublications"')),
    );
    expect(statement).toContain('"s3:DeleteObject"');
    expect(statement).toContain('"s3:DeleteObjectVersion"');
    expect(statement).toContain('"${bucket_arn}/artifacts/organizations/*"');
    expect(source).toContain(
      'for_each = each.key == "brain-erasure-worker" ? [1] : []\n    content {\n      sid     = "EraseBrainRunPublications"',
    );
  });

  test("fails erasure closed until the tenant inventory backfill is ready", () => {
    expect(erasureSource).toContain(
      "makeDynamoGovernanceStore(documentClient, tables, {\n  requireTenantInventoryReady: true,\n})",
    );
  });

  test("lets only the index worker invoke document extraction", () => {
    const invoke = statement("InvokeDocumentExtraction");
    expect(invoke).toContain('for_each = each.key == "brain-index-worker" ? [1] : []');
    expect(invoke).toContain('actions   = ["lambda:InvokeFunction"]');
    expect(invoke).toContain("resources = [var.document_extraction_function.arn]");
  });

  test("lets the index worker write extracted text only once and only at its derived key", () => {
    const write = statement("WriteBrainDocumentText");
    expect(write).toContain('for_each = each.key == "brain-index-worker" ? [1] : []');
    expect(write).toContain('actions   = ["s3:PutObject"]');
    expect(write).toMatch(
      /test\s+= "StringEquals"\n\s+variable = "s3:if-none-match"\n\s+values\s+= \["\*"\]/u,
    );
    const [resource] = /resources = \["\$\{var\.content_bucket_arn\}\/([^"]+)"\]/u
      .exec(write)!
      .slice(1);
    const pattern = new RegExp(
      `^${resource!.replaceAll(".", "\\.").replaceAll("*", "[^/]+")}$`,
      "u",
    );
    const key = brainNormalizedTextKey({
      brainId: "01K00000000000000000000002",
      documentVersionId: "01K00000000000000000000003",
      organizationId: "01K00000000000000000000001",
    });
    expect(pattern.test(key)).toBe(true);
    expect(pattern.test(key.replace("/text/", "/uploads/"))).toBe(false);
  });

  test("gives the index worker the extraction function and the data key it writes with", () => {
    const worker = source.slice(source.indexOf('resource "aws_lambda_function" "worker" {'));
    const environment = worker.slice(0, worker.indexOf("vpc_config"));
    expect(environment).toMatch(
      /DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME\s+= var\.document_extraction_function\.function_name/u,
    );
    expect(environment).toMatch(/DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN\s+= var\.data_kms_key_arn/u);
    for (const name of [
      "DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME",
      "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
    ]) {
      expect(indexWorkerSource).toMatch(
        new RegExp(`requiredEnvironment\\(\\s*environment,\\s*"${name}",?\\s*\\)`, "u"),
      );
    }
  });
});
