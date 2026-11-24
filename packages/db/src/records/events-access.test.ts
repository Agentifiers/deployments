import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { ACCESS_PATTERN_REGISTRY } from "../access-patterns.ts";
import { Ulid } from "../ids.ts";
import { key, Keys } from "../keys.ts";
import { canonicalRecordKeys } from "../record-keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";
const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("record catalog", () => {
  test("rejects invalid semantic event aggregate versions", async () => {
    const semanticEvent = (aggregateVersion: number) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion,
            environmentId: BILLING_ID,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
            projectId: BILLING_ID,
          },
          itemType: "semantic-event",
        }),
      );

    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent(0)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent(1.5)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(semanticEvent(1)))).toBe(true);
  });

  test("rejects persisted semantic events beyond envelope string limits", async () => {
    const semanticEvent = (aggregateType: string, traceId: string) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType,
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
            traceId,
          },
          itemType: "semantic-event",
        }),
      );

    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent("x".repeat(129), "trace"))),
    ).toBe(true);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent("organization", "x".repeat(257)))),
    ).toBe(true);
  });

  test("rejects semantic event types that EventBridge cannot dispatch", async () => {
    const semanticEvent = (eventType: string) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType,
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
          },
          itemType: "semantic-event",
        }),
      );

    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent("   ")))).toBe(true);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent(" organization.updated "))),
    ).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent("x".repeat(129))))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(semanticEvent("x".repeat(128))))).toBe(true);
  });

  test("rejects semantic events whose serialized EventBridge detail is too large", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: { body: "\0".repeat(180_000) },
          },
          itemType: "semantic-event",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects semantic event records above DynamoDB's item-size limit", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: { body: "x".repeat(410_000) },
          },
          itemType: "semantic-event",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects invalid ordered message sequences", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            contentHash: "sha256:message",
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: BILLING_ID,
            id: MESSAGE_1_ID,
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            role: "user",
            sequence: 1.5,
            threadId: MESSAGE_2_ID,
          },
          itemType: "message",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("registers scoped uniqueness for agent-definition slugs", async () => {
    const record = await Effect.runPromise(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            createdByPrincipalId: BILLING_ID,
            draft: {
              apiVersion: "agents.deployments.ai/v1",
              kind: "Agent",
              metadata: {
                key: "release-manager",
                name: "Release Manager",
                version: "1.0.0",
              },
              spec: {
                instructions: "Manage release tasks.",
                model: { id: "openrouter/test" },
                sandbox: { mode: "none" },
              },
            },
            environmentId: BILLING_ID,
            id: MESSAGE_1_ID,
            name: "Release Manager",
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            slug: "release-manager",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "agent-definition",
        }),
      ),
    );

    expect(uniqueClaimRequirements(record)).toEqual([
      {
        namespace: `environment:${BILLING_ID}:agent-definition-slug`,
        ownerId: MESSAGE_1_ID,
        ownerItemType: "agent-definition",
        ownerPk: record.pk,
        ownerSk: record.sk,
        ownerTable: "control",
        value: "release-manager",
      },
    ]);
  });

  test("uses the full inbox address as a global routing claim", async () => {
    const inbox = (
      environmentId: typeof BILLING_ID,
      id: typeof MESSAGE_1_ID,
      address = "agent@example.com",
    ) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            address,
            createdAt: "2026-07-20T00:00:00.000Z",
            domainId: MESSAGE_2_ID,
            environmentId,
            id,
            localPart: "agent",
            metadata: {},
            organizationId: ORG_ID,
            placementId: BILLING_ID,
            projectId: BILLING_ID,
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "inbox",
        }),
      );

    const firstRecord = await Effect.runPromise(inbox(BILLING_ID, MESSAGE_1_ID));
    const secondRecord = await Effect.runPromise(inbox(MESSAGE_2_ID, MESSAGE_2_ID));
    const firstClaim = uniqueClaimRequirements(firstRecord)[0];
    const secondClaim = uniqueClaimRequirements(secondRecord)[0];

    expect(firstClaim).toEqual({
      namespace: "inbox-address",
      ownerId: MESSAGE_1_ID,
      ownerItemType: "inbox",
      ownerPk: firstRecord.pk,
      ownerSk: firstRecord.sk,
      ownerTable: "control",
      value: "agent@example.com",
    });
    expect(secondClaim).toMatchObject({
      namespace: firstClaim?.namespace,
      value: firstClaim?.value,
    });
    expect(
      Keys.control.uniqueClaim(secondClaim?.namespace ?? "", secondClaim?.value ?? ""),
    ).toEqual(Keys.control.uniqueClaim("inbox-address", "agent@example.com"));

    for (const invalidAddress of ["agent", " Agent@example.com", "Agent@example.com"]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(inbox(BILLING_ID, MESSAGE_1_ID, invalidAddress)),
        ),
      ).toBe(true);
    }
  });

  test("reserves one inbox binding per environment, type, and external ID", () => {
    const record = withCanonicalRecordKeys({
      data: {
        bindingType: "platform_agent",
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: BILLING_ID,
        externalId: MESSAGE_2_ID,
        id: MESSAGE_1_ID,
        inboxId: BILLING_ID,
        metadata: {},
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "inbox-binding",
    } as const);

    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: `organization:${ORG_ID}:project:${BILLING_ID}:environment:${BILLING_ID}:inbox-binding:platform_agent`,
        value: MESSAGE_2_ID,
      },
    ]);
  });

  test("reserves one active suppression per environment and normalized address", () => {
    const active = withCanonicalRecordKeys({
      data: {
        address: "Agent@Example.com",
        createdAt: "2026-07-20T00:00:00.000Z",
        emailHash: "sha256:agent@example.com",
        environmentId: BILLING_ID,
        id: MESSAGE_1_ID,
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        reason: "manual",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "inbox-suppression",
    } as const);
    const removed = withCanonicalRecordKeys({
      ...active,
      data: { ...active.data, status: "removed", version: 1 },
    });

    expect(uniqueClaimRequirements(active)).toMatchObject([
      {
        namespace: `organization:${ORG_ID}:project:${BILLING_ID}:environment:${BILLING_ID}:inbox-suppression`,
        value: "sha256:agent@example.com",
      },
      {
        namespace: `organization:${ORG_ID}:inbox-suppression-address:sha256:agent@example.com`,
        value: `${BILLING_ID}:${MESSAGE_1_ID}`,
      },
    ]);
    expect(uniqueClaimRequirements(removed)).toEqual([]);
  });

  test("reserves one active grant per agent and memory space", () => {
    const active = withCanonicalRecordKeys({
      data: {
        agentDefinitionId: MESSAGE_1_ID,
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: BILLING_ID,
        id: MESSAGE_2_ID,
        memorySpaceId: ORG_ID,
        organizationId: ORG_ID,
        permission: "read-write" as const,
        projectId: BILLING_ID,
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "memory-space-grant" as const,
    });
    const revoked = withCanonicalRecordKeys({
      ...active,
      data: {
        ...active.data,
        revokedAt: "2026-07-21T00:00:00.000Z",
        version: 1,
      },
    });

    expect(uniqueClaimRequirements(active)).toMatchObject([
      {
        namespace: `environment:${BILLING_ID}:memory-space-grant`,
        value: `${MESSAGE_1_ID}:${ORG_ID}`,
      },
    ]);
    expect(uniqueClaimRequirements(revoked)).toEqual([]);
  });

  test("does not make run locators part of run write invariants", () => {
    const run = withCanonicalRecordKeys({
      data: {
        agentDeploymentId: MESSAGE_1_ID,
        agentReleaseId: MESSAGE_2_ID,
        attempt: 0,
        captureMode: "metadata-only" as const,
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: BILLING_ID,
        executor: "test",
        id: MESSAGE_2_ID,
        idempotencyKey: "run:locator-test",
        organizationId: ORG_ID,
        priority: 0,
        projectId: BILLING_ID,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "queued" as const,
        threadId: MESSAGE_1_ID,
        trigger: "test",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "run" as const,
    });

    expect(uniqueClaimRequirements(run)).toEqual([]);
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
    expect(executionActivity?.recordTypes).not.toContain("generation-reasoning");
    expect(executionActivity?.recordTypes).toContain("tool-call");
    const workQueue = ACCESS_PATTERN_REGISTRY.find(
      (pattern) => pattern.name === "execution.work-queue",
    );
    expect(workQueue?.recordTypes).toContain("memory-flush");
    expect(workQueue?.recordTypes).not.toContain("schedule-fire");
    expect(usageEnvironment?.recordTypes).not.toContain("rate-limit-counter");
    expect(
      ACCESS_PATTERN_REGISTRY.find(
        (pattern) => pattern.name === "control.agent-memory-space-grants",
      )?.recordTypes,
    ).toEqual(["memory-space-grant"]);
    expect(
      ACCESS_PATTERN_REGISTRY.find((pattern) => pattern.name === "execution.memory-telemetry")
        ?.recordTypes,
    ).toEqual(["memory-recall-attempt", "memory-retrieval"]);
    expect(
      ACCESS_PATTERN_REGISTRY.find(
        (pattern) => pattern.name === "execution.workspace-memory-telemetry",
      )?.recordTypes,
    ).toEqual(["memory-recall-attempt", "memory-retrieval"]);
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

describe("keys", () => {
  test("orders message sequences lexicographically", () => {
    const first = key("MESSAGE", "9".padStart(16, "0"), MESSAGE_1_ID);
    const second = key("MESSAGE", "10".padStart(16, "0"), MESSAGE_2_ID);
    expect(first < second).toBe(true);
  });

  test("escapes untrusted key parts", () => {
    const result = Keys.control.uniqueClaim("organization#slug", "request/one");
    expect(result.pk).toBe("UNIQUE#organization%23slug");
    expect(result.sk).toBe("VALUE#request%2Fone");
  });

  test("uses semantic identities for coordination records", () => {
    const runtimeLease = canonicalRecordKeys(
      {
        data: { id: ORG_ID, leaseKey: "scheduler/global" },
        itemType: "runtime-lease",
      },
      "execution",
    );
    const scheduleFire = canonicalRecordKeys(
      {
        data: { fireKey: "2026-07-20T12:00:00.000Z", id: BILLING_ID, scheduleId: ORG_ID },
        itemType: "schedule-fire",
      },
      "execution",
    );

    expect(runtimeLease.sk).toBe("RUNTIME-LEASE#scheduler%2Fglobal");
    expect(scheduleFire.sk).toBe(`SCHEDULE-FIRE#${ORG_ID}#2026-07-20T12%3A00%3A00.000Z`);
  });

  test("registers semantic identities for records without an id field", () => {
    const providerDefinition = canonicalRecordKeys(
      {
        data: { key: "github" },
        itemType: "provider-definition",
      },
      "control",
    );
    const memoryIndexState = canonicalRecordKeys(
      {
        data: { memoryId: ORG_ID, organizationId: ORG_ID },
        itemType: "memory-index-state",
      },
      "control",
    );

    expect(providerDefinition.sk).toBe("PROVIDER-DEFINITION#github");
    expect(memoryIndexState.sk).toBe(`MEMORY-INDEX-STATE#${ORG_ID}`);
  });

  test("uses idempotency keys for metering and provider mutation claims", () => {
    const meterEvent = canonicalRecordKeys(
      {
        data: { id: ORG_ID, idempotencyKey: "meter/request-1", organizationId: ORG_ID },
        itemType: "meter-event",
      },
      "usage",
    );
    const providerMutation = canonicalRecordKeys(
      {
        data: {
          claimAttemptId: "attempt-1",
          id: BILLING_ID,
          idempotencyKey: "mutation/request-1",
          organizationId: ORG_ID,
          runId: BILLING_ID,
        },
        itemType: "provider-mutation-claim",
      },
      "execution",
    );

    expect(meterEvent.sk).toBe("METER-EVENT#meter%2Frequest-1");
    expect(providerMutation.sk).toBe(
      `PROVIDER-MUTATION-CLAIM#${BILLING_ID}#7bbe061d8aa27f570647f700316bfe008160c4758594ccdfbb5271e8a07f5be4`,
    );
  });
});
