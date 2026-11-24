import { describe, expect, test } from "bun:test";
import { policyReach, retentionWarning } from "./copy.ts";

describe("policyReach", () => {
  test("names who a policy reaches by its scope", () => {
    expect(policyReach({ scope: "workspace", workspaceId: "01ARZ3NDEKTSV4RRFFQ69G600P" })).toBe(
      "Applies only to agents in workspace 01ARZ3NDEKTSV4RRFFQ69G600P.",
    );
    expect(policyReach({ scope: "environment" })).toBe(
      "Applies to every agent in this environment, except in workspaces with their own policy.",
    );
    expect(policyReach({ scope: "organization" })).toBe(
      "Applies in this environment only where no environment or workspace policy exists.",
    );
  });
});

const ORGANIZATION = { retentionDays: 365, scope: "organization" } as const;
const ENVIRONMENT = { retentionDays: 90, scope: "environment" } as const;

describe("retentionWarning", () => {
  test("warns that a new or shorter retention deletes the memories the policy reaches", () => {
    expect(
      retentionWarning({ current: undefined, next: 30, policies: [], scope: "organization" }),
    ).toBe(
      "Memories this policy reaches that are older than 30 days, counted from when each was created, will be permanently deleted, whatever their space's retention.",
    );
    expect(
      retentionWarning({
        current: ENVIRONMENT,
        next: 7,
        policies: [ENVIRONMENT],
        scope: "environment",
      }),
    ).toBe(
      "Retention for the memories this policy reaches drops from 90 to 7 days. Those older than 7 days, counted from when each was created, will be permanently deleted.",
    );
  });

  test("an organization policy shadowed by an environment policy deletes nothing", () => {
    expect(
      retentionWarning({
        current: ORGANIZATION,
        next: 7,
        policies: [ORGANIZATION, ENVIRONMENT],
        scope: "organization",
      }),
    ).toBeUndefined();
    expect(
      retentionWarning({
        current: undefined,
        next: 7,
        policies: [ENVIRONMENT],
        scope: "organization",
      }),
    ).toBeUndefined();
  });

  test("a new environment policy is measured against the organization policy it takes over from", () => {
    expect(
      retentionWarning({
        current: undefined,
        next: undefined,
        policies: [ORGANIZATION],
        scope: "environment",
      }),
    ).toBe(
      "The memories this policy reaches leave the 365-day retention they have now and fall back to their space's retention. Those older than their space's retention, counted from when each was created, will be permanently deleted.",
    );
    expect(
      retentionWarning({
        current: undefined,
        next: 30,
        policies: [ORGANIZATION],
        scope: "environment",
      }),
    ).toBe(
      "Retention for the memories this policy reaches drops from 365 to 30 days. Those older than 30 days, counted from when each was created, will be permanently deleted.",
    );
    expect(
      retentionWarning({
        current: undefined,
        next: 400,
        policies: [ORGANIZATION],
        scope: "environment",
      }),
    ).toBeUndefined();
    expect(
      retentionWarning({ current: undefined, next: undefined, policies: [], scope: "environment" }),
    ).toBeUndefined();
  });

  test("says nothing when retention stays or grows", () => {
    const workspace = { retentionDays: 30, scope: "workspace" } as const;
    for (const next of [30, 60]) {
      expect(
        retentionWarning({ current: workspace, next, policies: [workspace], scope: "workspace" }),
      ).toBeUndefined();
    }
  });
});
