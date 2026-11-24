import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ACCESS_PATTERN_REGISTRY } from "../access-patterns.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { BudgetPeriodRecord, BudgetRecord } from "../records/usage.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  RUN_SCOPE,
  WORKSPACE_ID,
  WORKSPACE_RUN_SCOPE,
  budgetRecord,
} from "./budget-test-support.ts";
import { scopeSpendShardCandidates } from "./spend.ts";

describe("budget records", () => {
  test("keys every budget by organization and indexes it by scope and status", () => {
    expect(budgetRecord({ scope: "environment" })).toMatchObject({
      gsi1pk: `ORG#${ORGANIZATION_ID}#BUDGET-SCOPE#ENV#${ENVIRONMENT_ID}`,
      gsi1sk: "BUDGET#active#01J000000000000000000BDG01",
      pk: `ORG#${ORGANIZATION_ID}`,
      sk: "BUDGET#01J000000000000000000BDG01",
    });
    expect(budgetRecord({ scope: "project", status: "paused" })).toMatchObject({
      gsi1pk: `ORG#${ORGANIZATION_ID}#BUDGET-SCOPE#PROJECT#${PROJECT_ID}`,
      gsi1sk: "BUDGET#paused#01J000000000000000000BDG01",
    });
    expect(budgetRecord({ scope: "workspace" })).toMatchObject({
      data: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      gsi1pk: `ORG#${ORGANIZATION_ID}#BUDGET-SCOPE#WORKSPACE#${WORKSPACE_ID}`,
      pk: `ORG#${ORGANIZATION_ID}`,
    });
    expect(budgetRecord({ scope: "organization" }).gsi2pk).toBeUndefined();
  });

  test("rejects scope identifiers that do not match the scope level", () => {
    const decode = (data: Record<string, unknown>) =>
      Schema.decodeUnknownSync(BudgetRecord)(
        withCanonicalRecordKeys({
          data: { ...budgetRecord({ scope: "organization" }).data, ...data },
          itemType: "budget" as const,
        }),
      );
    expect(() => decode({ projectId: PROJECT_ID })).toThrow();
    expect(() => decode({ environmentId: ENVIRONMENT_ID, scope: "environment" })).toThrow();
    expect(() =>
      decode({ environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, scope: "workspace" }),
    ).toThrow();
    expect(() =>
      decode({
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        scope: "environment",
        workspaceId: WORKSPACE_ID,
      }),
    ).toThrow();
    expect(() => decode({ status: "archived" })).toThrow();
    expect(() => decode({ thresholds: [50, 50] })).toThrow();
    expect(() => decode({ thresholds: [101] })).toThrow();
  });

  test("keys period state under its budget and spend shards under their scope", () => {
    const period = Schema.decodeUnknownSync(BudgetPeriodRecord)(
      withCanonicalRecordKeys({
        data: {
          budgetId: "01J000000000000000000BDG01",
          createdAt: "2026-01-02T00:00:00.000Z",
          id: "01J000000000000000000PER01",
          notifiedThresholds: [50],
          organizationId: ORGANIZATION_ID,
          period: "monthly",
          periodEnd: "2026-02-01T00:00:00.000Z",
          periodStart: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          version: 1,
        },
        itemType: "budget-period" as const,
      }),
    );
    expect(period).toMatchObject({
      pk: `ORG#${ORGANIZATION_ID}#BUDGET#01J000000000000000000BDG01`,
      sk: "BUDGET-PERIOD#2026-01-01T00%3A00%3A00.000Z",
    });
    expect(period.gsi1pk).toBeUndefined();

    const shards = scopeSpendShardCandidates({
      occurredAt: "2026-01-15T00:00:00.000Z",
      scope: RUN_SCOPE,
      shard: 3,
      updatedAt: "2026-01-15T00:00:00.000Z",
    });
    expect(shards.map((shard) => [shard.pk, shard.sk])).toContainEqual([
      `ORG#${ORGANIZATION_ID}#SPEND#ORGANIZATION`,
      "SCOPE-SPEND-SHARD#quarterly#2026-01-01T00%3A00%3A00.000Z#03",
    ]);
    expect(new Set(shards.map((shard) => shard.pk))).toEqual(
      new Set([
        `ORG#${ORGANIZATION_ID}#SPEND#ENV#${ENVIRONMENT_ID}`,
        `ORG#${ORGANIZATION_ID}#SPEND#PROJECT#${PROJECT_ID}`,
        `ORG#${ORGANIZATION_ID}#SPEND#ORGANIZATION`,
      ]),
    );
    expect(shards.every((shard) => shard.gsi1pk === undefined)).toBe(true);

    const workspaceShards = scopeSpendShardCandidates({
      occurredAt: "2026-01-15T00:00:00.000Z",
      scope: WORKSPACE_RUN_SCOPE,
      shard: 3,
      updatedAt: "2026-01-15T00:00:00.000Z",
    });
    expect(workspaceShards).toHaveLength(16);
    expect(
      workspaceShards
        .filter((shard) => shard.data.scope === "workspace")
        .map((shard) => [shard.pk, shard.data.period]),
    ).toEqual(
      ["daily", "monthly", "quarterly", "yearly"].map((period) => [
        `ORG#${ORGANIZATION_ID}#SPEND#WORKSPACE#${WORKSPACE_ID}`,
        period,
      ]),
    );
  });

  test("registers budget access patterns outside the metric projections", () => {
    const patterns = ACCESS_PATTERN_REGISTRY.filter((pattern) => pattern.table === "usage");
    const recordTypes = (name: string) =>
      patterns.find((pattern) => pattern.name === name)?.recordTypes ?? [];
    expect(recordTypes("usage.budget-scope")).toEqual(["budget"]);
    expect(recordTypes("usage.budget-state")).toEqual([
      "budget",
      "budget-period",
      "scope-spend-shard",
    ]);
    expect(recordTypes("usage.organization-metrics")).not.toContain("scope-spend-shard");
    expect(recordTypes("usage.environment-metrics")).not.toContain("budget");
  });
});
