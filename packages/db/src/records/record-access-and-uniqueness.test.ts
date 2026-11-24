import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { ACCESS_PATTERN_REGISTRY } from "../access-patterns.ts";
import { Ulid } from "../ids.ts";
import { Keys } from "../keys.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("record routing and claims", () => {
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
  test("separates custom-domain registration from verified global ownership", () => {
    const pending = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        dnsRecords: [],
        domain: "Mail.Example.com",
        environmentId: BILLING_ID,
        id: MESSAGE_1_ID,
        mailFromDomain: "bounce.mail.example.com",
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        providerManaged: false,
        providerMetadata: {},
        status: "pending" as const,
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "inbox-domain" as const,
    });
    const verified = withCanonicalRecordKeys({
      ...pending,
      data: {
        ...pending.data,
        status: "verified" as const,
        verifiedAt: "2026-07-20T00:01:00.000Z",
        version: 1,
      },
    });
    const revoked = withCanonicalRecordKeys({
      ...verified,
      data: { ...verified.data, status: "revoked" as const, version: 2 },
    });
    const registrationNamespace = `organization:${ORG_ID}:project:${BILLING_ID}:environment:${BILLING_ID}:inbox-domain`;

    expect(uniqueClaimRequirements(pending)).toMatchObject([
      { namespace: registrationNamespace, value: "mail.example.com" },
    ]);
    expect(uniqueClaimRequirements(verified)).toMatchObject([
      { namespace: registrationNamespace, value: "mail.example.com" },
      { namespace: "inbox-domain", value: "mail.example.com" },
    ]);
    expect(uniqueClaimRequirements(revoked)).toMatchObject([
      { namespace: registrationNamespace, value: "mail.example.com" },
    ]);
  });

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

  test("scopes the default inbox placement claim to its full environment hierarchy", () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        dedicatedPool: false,
        environmentId: MESSAGE_2_ID,
        id: MESSAGE_1_ID,
        isDefault: true,
        name: "Default",
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        provider: "ses",
        providerMetadata: {},
        region: "us-east-2",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 0,
      },
      itemType: "inbox-placement",
    } as const);

    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: `organization:${ORG_ID}:project:${BILLING_ID}:environment:${MESSAGE_2_ID}:default-inbox-placement`,
        value: "default",
      },
    ]);
  });

  test("claims one default memory space per workspace and none for other spaces", () => {
    const space = (data: { readonly isDefault?: boolean; readonly workspaceId?: Ulid }) =>
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: BILLING_ID,
          id: MESSAGE_1_ID,
          kind: "workspace",
          name: "Workspace memory",
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version: 0,
          ...data,
        },
        itemType: "memory-space",
      } as const);

    expect(
      uniqueClaimRequirements(space({ isDefault: true, workspaceId: MESSAGE_2_ID })),
    ).toMatchObject([
      {
        namespace: `environment:${BILLING_ID}:default-workspace-memory-space`,
        value: MESSAGE_2_ID,
      },
    ]);
    expect(uniqueClaimRequirements(space({ workspaceId: MESSAGE_2_ID }))).toEqual([]);
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
