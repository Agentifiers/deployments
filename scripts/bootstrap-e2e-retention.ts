import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoGovernanceStore, tableNamesFromEnvironment, Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { e2eRetentionPolicyPlan } from "./bootstrap-e2e-retention-support.ts";
import { runMain } from "./platform-deploy/process.ts";
import { required } from "./required-environment.ts";

// Bounds the credentialed E2E organization's retention so the daily retention sweep removes
// earlier runs' records instead of letting the organization grow for a year.

async function main() {
  const organizationId = Schema.decodeUnknownSync(Ulid)(
    required("DEPLOYMENTS_E2E_ORGANIZATION_ID"),
  );
  const principalId = Schema.decodeUnknownSync(Ulid)(required("DEPLOYMENTS_E2E_PRINCIPAL_ID"));
  const baseClient = new DynamoDBClient({});
  try {
    const store = makeDynamoGovernanceStore(
      DynamoDBDocumentClient.from(baseClient, {
        marshallOptions: { removeUndefinedValues: true },
      }),
      tableNamesFromEnvironment(),
    );
    const plan = e2eRetentionPolicyPlan({
      current: await store.getRetentionPolicy(organizationId),
      now: new Date().toISOString(),
      organizationId,
      principalId,
    });
    if (plan) await store.putRetentionPolicy(plan.policy, plan.previousVersion);
    console.log(
      plan
        ? "Credentialed E2E organization retention bounded."
        : "Credentialed E2E organization retention already bounded.",
    );
  } finally {
    baseClient.destroy();
  }
}

if (import.meta.main) runMain(main);
