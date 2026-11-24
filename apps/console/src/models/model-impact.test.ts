import { describe, expect, test } from "bun:test";
import type { EffectiveModelPolicy } from "@deployments-ai/model-gateway/model-policy";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  impactCheck,
  impactIsDestructive,
  modelPolicyImpact,
  modelVerdict,
  policyRuleCheck,
  type LiveDeploymentRef,
  type ModelFacts,
  type ReleaseRead,
} from "./model-impact.ts";

const CURATED = "openai/gpt-4o-mini";
const SYNCED = "openai/gpt-5.4-mini";
const SYNCED_ROUTER = "openrouter/meta-llama/llama-4-scout";
const GRANTED = "bedrock/amazon.nova-pro-v1:0";

const facts: ModelFacts = {
  allowedNow: new Map([
    [CURATED, true],
    [SYNCED, true],
    [SYNCED_ROUTER, false],
    [GRANTED, true],
  ]),
  synced: new Set([SYNCED, SYNCED_ROUTER, GRANTED]),
};

const curatedDefaults: EffectiveModelPolicy = { source: "curated-defaults" };

function policy(includeCuratedModels: boolean, models: readonly string[]): EffectiveModelPolicy {
  return {
    modelPolicyId: "01M4MPC00000000000000000PA",
    rules: { includeCuratedModels, models },
    source: "model-policy",
  };
}

describe("modelVerdict", () => {
  test("dropping the curated set denies a curated model the policy does not name", () => {
    expect(modelVerdict(CURATED, policy(true, [SYNCED]), policy(false, [SYNCED]), facts)).toEqual({
      kind: "newly_denied",
      reason: "model_not_allowed_by_environment_policy",
    });
  });

  test("a provider wildcard keeps every synced model of that provider", () => {
    expect(modelVerdict(SYNCED, policy(true, [SYNCED]), policy(true, ["openai/*"]), facts)).toEqual(
      {
        basis: "environment-policy",
        kind: "unchanged_allowed",
      },
    );
  });

  test("removing an exact entry denies that model", () => {
    expect(modelVerdict(SYNCED, policy(true, [SYNCED]), policy(true, []), facts)).toEqual({
      kind: "newly_denied",
      reason: "model_not_allowed_by_environment_policy",
    });
  });

  test("a model the listing allows but the policy denies today is held by an operator grant", () => {
    expect(modelVerdict(GRANTED, curatedDefaults, policy(false, [SYNCED]), facts)).toEqual({
      basis: "operator-grant",
      kind: "unchanged_allowed",
    });
  });

  test("a model denied today and after is not caused by the change", () => {
    expect(modelVerdict(SYNCED_ROUTER, curatedDefaults, policy(true, [SYNCED]), facts)).toEqual({
      kind: "already_denied",
      reason: "model_not_allowed_by_environment_policy",
    });
  });

  test("a model outside the catalog stays denied even when the policy names its provider", () => {
    expect(
      modelVerdict("openai/not-synced", curatedDefaults, policy(true, ["openai/*"]), facts),
    ).toEqual({ kind: "already_denied", reason: "model_not_allowed_by_environment_policy" });
    expect(
      modelVerdict(
        "openai/not-synced",
        policy(true, ["openai/*"]),
        policy(true, ["openai/*"]),
        facts,
      ),
    ).toEqual({ kind: "already_denied", reason: "model_not_in_catalog" });
  });

  test("adding a model admits it", () => {
    expect(
      modelVerdict(SYNCED_ROUTER, curatedDefaults, policy(true, ["openrouter/*"]), facts),
    ).toEqual({
      kind: "newly_allowed",
    });
  });

  test("archiving returns to curated defaults, which deny synced models", () => {
    expect(modelVerdict(SYNCED, policy(true, [SYNCED]), curatedDefaults, facts)).toEqual({
      kind: "newly_denied",
      reason: "model_not_allowed_by_environment_policy",
    });
  });
});

const releases = new Map<string, ReleaseRead>([
  [
    "R1",
    { agentDefinitionId: "A1", models: { fallbacks: [], primary: CURATED }, releaseNumber: 3 },
  ],
  [
    "R2",
    {
      agentDefinitionId: "A1",
      models: { fallbacks: [SYNCED], primary: CURATED },
      releaseNumber: 4,
    },
  ],
  [
    "R3",
    {
      agentDefinitionId: "A2",
      models: { fallbacks: [], primary: SYNCED_ROUTER },
      releaseNumber: 1,
    },
  ],
  ["R4", { problem: { code: "not_found", status: 404, title: "Not found" } }],
]);

function deployment(
  id: string,
  agentReleaseId: string,
  desiredState: LiveDeploymentRef["desiredState"] = "running",
  candidateAgentReleaseId?: string,
): LiveDeploymentRef {
  return { agentReleaseId, candidateAgentReleaseId, desiredState, id };
}

describe("modelPolicyImpact", () => {
  test("a denied fallback fails the release, and a canary candidate counts", () => {
    const impact = modelPolicyImpact({
      current: policy(true, [SYNCED]),
      deployments: [deployment("D1", "R1", "running", "R2"), deployment("D2", "R3", "paused")],
      listsComplete: true,
      facts,
      next: policy(true, []),
      releases,
    });
    expect(impact).toEqual({
      alreadyDenied: [
        {
          agentDefinitionId: "A2",
          deployments: [{ id: "D2", role: "primary" }],
          models: [
            {
              modelId: SYNCED_ROUTER,
              slot: "primary",
              verdict: {
                kind: "already_denied",
                reason: "model_not_allowed_by_environment_policy",
              },
            },
          ],
          releaseId: "R3",
          releaseNumber: 1,
        },
      ],
      newlyDenied: [
        {
          agentDefinitionId: "A1",
          deployments: [{ id: "D1", role: "candidate" }],
          models: [
            {
              modelId: CURATED,
              slot: "primary",
              verdict: { basis: "environment-policy", kind: "unchanged_allowed" },
            },
            {
              modelId: SYNCED,
              slot: "fallback",
              verdict: { kind: "newly_denied", reason: "model_not_allowed_by_environment_policy" },
            },
          ],
          releaseId: "R2",
          releaseNumber: 4,
        },
      ],
      scan: {
        complete: true,
        deployments: 2,
        listsComplete: true,
        releases: 3,
        skipped: 0,
        unread: 0,
      },
    });
    expect(impactIsDestructive(impact)).toBe(true);
  });

  test("stopped deployments are not scanned and an unchanged policy is not destructive", () => {
    const impact = modelPolicyImpact({
      current: policy(true, [SYNCED]),
      deployments: [deployment("D1", "R2"), deployment("D3", "R3", "stopped")],
      listsComplete: true,
      facts,
      next: policy(true, [SYNCED, "openrouter/*"]),
      releases,
    });
    expect(impact).toEqual({
      alreadyDenied: [],
      newlyDenied: [],
      scan: {
        complete: true,
        deployments: 1,
        listsComplete: true,
        releases: 1,
        skipped: 0,
        unread: 0,
      },
    });
    expect(impactIsDestructive(impact)).toBe(false);
  });

  test("an unreadable release and one past the release cap leave the scan incomplete", () => {
    const impact = modelPolicyImpact({
      current: curatedDefaults,
      deployments: [deployment("D4", "R4"), deployment("D5", "R9"), deployment("D1", "R1")],
      listsComplete: true,
      facts,
      next: curatedDefaults,
      releases,
    });
    expect(impact.scan).toEqual({
      complete: false,
      deployments: 3,
      listsComplete: true,
      releases: 3,
      skipped: 1,
      unread: 1,
    });
    expect(impactIsDestructive(impact)).toBe(true);
  });

  test("a deployment list cut short leaves the scan incomplete", () => {
    const impact = modelPolicyImpact({
      current: curatedDefaults,
      deployments: [deployment("D1", "R1")],
      listsComplete: false,
      facts,
      next: curatedDefaults,
      releases,
    });
    expect(impact.scan).toEqual({
      complete: false,
      deployments: 1,
      listsComplete: false,
      releases: 1,
      skipped: 0,
      unread: 0,
    });
  });

  test("a list cut short is reported alongside an unreadable release", () => {
    const impact = modelPolicyImpact({
      current: curatedDefaults,
      deployments: [deployment("D4", "R4")],
      listsComplete: false,
      facts,
      next: curatedDefaults,
      releases,
    });
    expect(impact.scan).toEqual({
      complete: false,
      deployments: 1,
      listsComplete: false,
      releases: 1,
      skipped: 0,
      unread: 1,
    });
  });
});

describe("policyRuleCheck", () => {
  const PAST_CAP = "openai/gpt-9";

  test("an entry missing from a complete catalog is an issue", () => {
    expect(
      policyRuleCheck(
        { includeCuratedModels: true, models: [SYNCED, PAST_CAP] },
        { complete: true, ids: new Set([SYNCED]) },
      ),
    ).toEqual({
      issues: [
        { entry: PAST_CAP, message: `Model ${PAST_CAP} is not in the platform model catalog.` },
      ],
      unchecked: [],
    });
  });

  test("an entry missing from a catalog cut short is unchecked, not an issue", () => {
    expect(
      policyRuleCheck(
        { includeCuratedModels: true, models: [SYNCED, PAST_CAP, "openai/*", "bad id"] },
        { complete: false, ids: new Set([SYNCED]) },
      ),
    ).toEqual({
      issues: [
        {
          entry: "bad id",
          message:
            "Model policy entry bad id must start with a supported provider prefix (bedrock/, openai/, openrouter/).",
        },
      ],
      unchecked: [PAST_CAP],
    });
  });
});

describe("impactCheck", () => {
  test("reopening the dialog shows the rescan, not the previous result", async () => {
    const scans: PromiseWithResolvers<string>[] = [];
    const observer = new QueryObserver(new QueryClient(), {
      enabled: true,
      gcTime: 0,
      queryFn: () => {
        const scan = Promise.withResolvers<string>();
        scans.push(scan);
        return scan.promise;
      },
      queryKey: ["models", "preview"],
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    scans[0]?.resolve("first scan");
    await observer.getCurrentQuery().promise;
    expect(impactCheck(observer.getCurrentResult())).toEqual({
      kind: "checked",
      preview: "first scan",
    });

    observer.setOptions({ ...observer.options, enabled: false });
    observer.setOptions({ ...observer.options, enabled: true });
    expect(scans).toHaveLength(2);
    expect(impactCheck(observer.getCurrentResult())).toEqual({ kind: "checking" });

    scans[1]?.resolve("second scan");
    await observer.getCurrentQuery().promise;
    expect(impactCheck(observer.getCurrentResult())).toEqual({
      kind: "checked",
      preview: "second scan",
    });
    unsubscribe();
  });

  test("a rescan paused offline is still checking, not the previous result", async () => {
    const scans: PromiseWithResolvers<string>[] = [];
    const observer = new QueryObserver(new QueryClient(), {
      enabled: true,
      gcTime: 0,
      queryFn: () => {
        const scan = Promise.withResolvers<string>();
        scans.push(scan);
        return scan.promise;
      },
      queryKey: ["models", "preview"],
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    scans[0]?.resolve("first scan");
    await observer.getCurrentQuery().promise;

    onlineManager.setOnline(false);
    try {
      observer.setOptions({ ...observer.options, enabled: false });
      observer.setOptions({ ...observer.options, enabled: true });
      expect(observer.getCurrentResult().fetchStatus).toBe("paused");
      expect(impactCheck(observer.getCurrentResult())).toEqual({ kind: "checking" });
    } finally {
      onlineManager.setOnline(true);
      unsubscribe();
    }
  });
});
