import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { ACCESS_PATTERN_REGISTRY } from "../access-patterns.ts";
import { Ulid } from "../ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("record routing and claims", () => {
  test("reserves managed skill source keys globally", () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        id: MESSAGE_1_ID,
        key: "release-tools",
        name: "Release tools",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "managed-skill-source",
    } as const);

    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: "managed-skill-source-key",
        value: "release-tools",
      },
    ]);
  });

  test("reserves managed skill versions within each source", () => {
    const record = withCanonicalRecordKeys({
      data: {
        activatedAt: "2026-07-20T00:00:00.000Z",
        contentHash: `sha256:${"a".repeat(64)}`,
        createdAt: "2026-07-20T00:00:00.000Z",
        id: MESSAGE_1_ID,
        manifest: {},
        releaseVersion: "1.0.0",
        skillIdsByKey: { release: MESSAGE_2_ID },
        skillCount: 1,
        sourceId: MESSAGE_2_ID,
        status: "active",
        version: 0,
      },
      itemType: "managed-skill-release",
    } as const);

    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: `managed-skill-source:${MESSAGE_2_ID}:release-version`,
        value: "1.0.0",
      },
    ]);
  });

  test("reserves one SES provider tenant per organization and region", () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        id: MESSAGE_1_ID,
        organizationId: ORG_ID,
        provider: "ses",
        providerMetadata: {},
        providerName: "agent-inboxes-tenant",
        region: "us-east-2",
        sendingStatus: "provisioning",
        suppressedReasons: ["bounce", "complaint"],
        suppressionScope: "tenant",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "inbox-provider-tenant",
    } as const);

    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: `organization:${ORG_ID}:inbox-provider-tenant`,
        value: "ses:us-east-2",
      },
    ]);
  });

  test("publishes the generated execution tenant-activity sort order", () => {
    expect(
      ACCESS_PATTERN_REGISTRY.find((pattern) => pattern.name === "execution.tenant-activity")
        ?.sortKey,
    ).toBe("<itemType>#<status>#<updatedAt>#<resourceId>");
  });

  test("publishes only record types projected into sparse indexes", () => {
    const controlOrganization = ACCESS_PATTERN_REGISTRY.find(
      (pattern) => pattern.name === "control.organization-resources",
    );
    const executionActivity = ACCESS_PATTERN_REGISTRY.find(
      (pattern) => pattern.name === "execution.tenant-activity",
    );
    const usageEnvironment = ACCESS_PATTERN_REGISTRY.find(
      (pattern) => pattern.name === "usage.environment-metrics",
    );

    expect(controlOrganization?.recordTypes).not.toContain("principal");
    expect(controlOrganization?.recordTypes).not.toContain("unique-claim");
    expect(executionActivity?.recordTypes).not.toContain("runtime-lease");
    expect(executionActivity?.recordTypes).not.toContain("run");
    expect(
      ACCESS_PATTERN_REGISTRY.find((pattern) => pattern.name === "execution.deployment-runs")
        ?.recordTypes,
    ).toEqual(["run"]);
    const workQueue = ACCESS_PATTERN_REGISTRY.find(
      (pattern) => pattern.name === "execution.work-queue",
    );
    expect(workQueue?.recordTypes).toContain("memory-flush");
    expect(workQueue?.recordTypes).not.toContain("schedule-fire");
    expect(usageEnvironment?.recordTypes).not.toContain("rate-limit-counter");
  });

  test("requires workspaceId for workspace-scoped memory policies", async () => {
    const input = {
      data: {
        activeRecallEnabled: true,
        activeRecallRolloutPercent: 100,
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: BILLING_ID,
        id: MESSAGE_1_ID,
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        scope: "workspace",
        sensitivityMode: "standard",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 1,
      },
      itemType: "memory-policy",
    } as const;

    const missingWorkspace = await Effect.runPromiseExit(
      decodePlatformRecord(withCanonicalRecordKeys(input)),
    );
    const withWorkspace = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          ...input,
          data: { ...input.data, workspaceId: MESSAGE_2_ID },
        }),
      ),
    );

    expect(Exit.isFailure(missingWorkspace)).toBe(true);
    expect(Exit.isSuccess(withWorkspace)).toBe(true);
  });

  test("allows organization semantic events without narrower scope IDs", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.created",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
          },
          itemType: "semantic-event",
        }),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
