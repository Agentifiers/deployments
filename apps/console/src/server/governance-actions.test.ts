import { OrganizationRetentionPolicyResponse } from "@deployments-ai/api-contract/governance";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { PlatformApiError } from "../errors.ts";
import type { RetentionPolicy } from "../governance/retention-state.ts";
import { updateRetentionPolicy, type CallRoute } from "./governance-actions.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G600C";
const policy = Schema.decodeUnknownSync(OrganizationRetentionPolicyResponse)({
  artifacts: 365,
  audit: 2555,
  createdAt: "2026-10-01T00:00:00.000Z",
  events: 365,
  messages: 365,
  organizationId: ORG,
  runs: 365,
  threads: 365,
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedByPrincipalId: ORG,
  version: 3,
});

function fakeApi(latest: RetentionPolicy) {
  const calls: string[] = [];
  const callRoute = (async (name: string, input: { readonly body?: object }) => {
    calls.push(name);
    if (name === "getOrganizationRetentionPolicy") return latest;
    return { ...latest, ...input.body, version: latest.version + 1 };
  }) as unknown as CallRoute;
  return { callRoute, calls };
}

const save = (expectedVersion: number, body: object) => ({
  accessToken: "token",
  body,
  expectedVersion,
  idempotencyKey: "key-1",
  organizationId: ORG,
});

describe("updateRetentionPolicy", () => {
  test("patches when the policy is still the version the dialog opened", async () => {
    const api = fakeApi(policy);
    expect(await updateRetentionPolicy(save(3, { runs: 400 }), api.callRoute)).toEqual({
      ...policy,
      runs: 400,
      version: 4,
    });
    expect(api.calls).toEqual([
      "getOrganizationRetentionPolicy",
      "updateOrganizationRetentionPolicy",
    ]);
  });

  test("returns the policy without patching when a retried save already applied", async () => {
    const api = fakeApi({ ...policy, runs: 400, version: 4 });
    expect(await updateRetentionPolicy(save(3, { runs: 400 }), api.callRoute)).toEqual({
      ...policy,
      runs: 400,
      version: 4,
    });
    expect(api.calls).toEqual(["getOrganizationRetentionPolicy"]);
  });

  test("refuses with retention_policy_changed when someone else changed it", async () => {
    const api = fakeApi({ ...policy, events: 90, version: 4 });
    const refused = await updateRetentionPolicy(save(3, { runs: 400 }), api.callRoute).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PlatformApiError);
    expect((refused as PlatformApiError).problem).toMatchObject({
      code: "retention_policy_changed",
      status: 409,
    });
    expect(api.calls).toEqual(["getOrganizationRetentionPolicy"]);
  });
});
