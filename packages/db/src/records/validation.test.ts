import { describe, expect, test } from "bun:test";
import { agentManifestContentHash } from "@deployments-ai/agent-manifest";
import { Effect, Exit, Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  MAX_DYNAMODB_ITEM_BYTES,
  Metadata,
  Money,
  PersistedNumber,
  QueuePriority,
  dynamoItemByteSize,
} from "../record-schema.ts";
import {
  RECORD_SCHEMAS,
  RECORD_TYPES_BY_TABLE,
  TABLE_NAMES,
  decodePlatformRecord,
  tableForItemType,
  withCanonicalRecordKeys,
} from "./index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("record validation", () => {
  test("sizes DynamoDB numbers by significant digits inside lists and maps", () => {
    expect(dynamoItemByteSize({ n: 1 })).toBe(3);
    expect(dynamoItemByteSize({ n: 123 })).toBe(4);
    expect(dynamoItemByteSize({ n: 1_000 })).toBe(3);
    expect(dynamoItemByteSize({ n: 1e21 })).toBe(3);
    expect(dynamoItemByteSize({ n: [1, 10, 100, 101] })).toBe(17);
    expect(dynamoItemByteSize({ value: { small: 1, precise: 12345 } })).toBe(28);
  });

  test("enforces the DynamoDB item boundary for numeric lists", () => {
    const fixedBytes = dynamoItemByteSize({ values: [] });
    const bytesPerSingleDigitNumber = 3;
    const fittingCount = Math.floor(
      (MAX_DYNAMODB_ITEM_BYTES - fixedBytes) / bytesPerSingleDigitNumber,
    );

    expect(dynamoItemByteSize({ values: Array(fittingCount).fill(1) })).toBeLessThanOrEqual(
      MAX_DYNAMODB_ITEM_BYTES,
    );
    expect(dynamoItemByteSize({ values: Array(fittingCount + 1).fill(1) })).toBeGreaterThan(
      MAX_DYNAMODB_ITEM_BYTES,
    );
  });

  test("registers every item type in exactly one table", () => {
    const catalogTypes = Object.keys(RECORD_SCHEMAS).sort();
    const tableTypes: string[] = TABLE_NAMES.flatMap((table) => [
      ...RECORD_TYPES_BY_TABLE[table],
    ]).sort();

    expect(catalogTypes.length).toBeGreaterThan(90);
    expect(tableTypes).toEqual(catalogTypes);
    expect(new Set(tableTypes).size).toBe(tableTypes.length);
    expect(tableForItemType("semantic-event")).toBe("events");
    expect(tableForItemType("run")).toBe("execution");
    expect(tableForItemType("principal-credential")).toBe("identity");
    expect(tableForItemType("oauth-client")).toBe("identity");
  });

  test("decodes a valid enveloped record with Effect Schema", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            billingAccountId: BILLING_ID,
            createdAt: "2026-07-20T00:00:00.000Z",
            id: ORG_ID,
            name: "Deployments.ai",
            slug: "deployments-ai",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
        }),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("rejects records that do not match the current schema", async () => {
    const incompleteInbox = withCanonicalRecordKeys({
      data: {
        address: "agent@agents.example.com",
        createdAt: "2026-07-19T00:00:00.000Z",
        domainId: MESSAGE_1_ID,
        environmentId: BILLING_ID,
        id: MESSAGE_2_ID,
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        status: "active",
        updatedAt: "2026-07-19T00:00:00.000Z",
        version: 1,
      },
      itemType: "inbox",
    } as const);

    const exit = await Effect.runPromiseExit(decodePlatformRecord(incompleteInbox));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects structurally valid releases that violate manifest semantics", async () => {
    const manifest = {
      apiVersion: "agents.deployments.ai/v1" as const,
      kind: "Agent" as const,
      metadata: {
        key: "invalid-release",
        name: "Invalid Release",
        version: "1.0.0",
      },
      spec: {
        capabilities: {
          tools: [
            { name: "records.read", required: true, requiredScopes: [] },
            { name: "records.read", required: false, requiredScopes: [] },
          ],
        },
        instructions: "Read records.",
        model: { id: "openrouter/test" },
        sandbox: { mode: "none" as const },
      },
    };
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: MESSAGE_1_ID,
            contentHash: agentManifestContentHash(manifest),
            createdAt: "2026-07-20T00:00:00.000Z",
            createdByPrincipalId: BILLING_ID,
            environmentId: BILLING_ID,
            id: MESSAGE_2_ID,
            manifest,
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            releaseNumber: 1,
            status: "active",
            version: 0,
          },
          itemType: "agent-release",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects environment-scoped provider tenant records", async () => {
    const environmentScopedTenant = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: BILLING_ID,
        id: MESSAGE_1_ID,
        organizationId: ORG_ID,
        projectId: BILLING_ID,
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

    const exit = await Effect.runPromiseExit(decodePlatformRecord(environmentScopedTenant));

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects removed agent email compatibility fields", async () => {
    const binding = withCanonicalRecordKeys({
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
    const suppression = withCanonicalRecordKeys({
      data: {
        address: "agent@example.com",
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
    const providerTenant = withCanonicalRecordKeys({
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

    const exits = await Promise.all([
      Effect.runPromiseExit(
        decodePlatformRecord({
          ...binding,
          data: { ...binding.data, uniqueClaimPending: true },
        }),
      ),
      Effect.runPromiseExit(
        decodePlatformRecord({
          ...suppression,
          data: { ...suppression.data, uniqueClaimPending: true },
        }),
      ),
      Effect.runPromiseExit(
        decodePlatformRecord({
          ...providerTenant,
          data: {
            ...providerTenant.data,
            environmentId: BILLING_ID,
            projectId: BILLING_ID,
          },
        }),
      ),
    ]);

    expect(exits.every(Exit.isFailure)).toBe(true);
  });

  test("rejects an unknown item type", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord({
        data: {},
        itemType: "vertical-specific-record",
        pk: "BAD",
        sk: "BAD",
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects incomplete sparse index keys", async () => {
    const canonical = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        id: ORG_ID,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    } as const);
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord({
        ...canonical,
        gsi1pk: `ORG#${ORG_ID}`,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects ttl on records without logical expiration", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            id: ORG_ID,
            name: "Deployments.ai",
            slug: "deployments-ai",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
          ttl: 1_800_000_000,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects blank unique values and noncanonical timestamps", async () => {
    const blankSlug = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            id: ORG_ID,
            name: "Deployments.ai",
            slug: "   ",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
        }),
      ),
    );
    const noncanonicalTime = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00Z",
            id: ORG_ID,
            name: "Deployments.ai",
            slug: "deployments-ai",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
        }),
      ),
    );

    expect(Exit.isFailure(blankSlug)).toBe(true);
    expect(Exit.isFailure(noncanonicalTime)).toBe(true);
  });

  test("rejects invalid credential expiration timestamps", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            credentialHash: "sha256:credential",
            environmentId: BILLING_ID,
            expiresAt: "never",
            id: MESSAGE_1_ID,
            keyPrefix: "dai_",
            name: "Automation",
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            scopes: [],
            serviceAccountId: MESSAGE_2_ID,
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1,
          },
          itemType: "api-credential",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects blank approval token and OAuth state hashes", async () => {
    const expiresAt = "2026-07-21T00:00:00.000Z";
    const ttl = Math.floor(Date.parse(expiresAt) / 1_000);
    const approvalToken = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            approvalId: MESSAGE_1_ID,
            channel: "slack",
            createdAt: "2026-07-20T00:00:00.000Z",
            expiresAt,
            id: MESSAGE_2_ID,
            organizationId: ORG_ID,
            status: "active",
            tokenHash: "   ",
            version: 1,
          },
          itemType: "approval-action-token",
          ttl,
        }),
      ),
    );
    const oauthAttempt = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: BILLING_ID,
            expiresAt,
            id: MESSAGE_2_ID,
            organizationId: ORG_ID,
            principalId: MESSAGE_1_ID,
            projectId: BILLING_ID,
            providerApplicationId: BILLING_ID,
            providerKey: "github",
            requestedScopes: [],
            returnTo: "https://app.example.com/settings/connections",
            stateHash: "",
            status: "pending",
            version: 1,
          },
          itemType: "oauth-authorization-attempt",
          ttl,
        }),
      ),
    );

    expect(Exit.isFailure(approvalToken)).toBe(true);
    expect(Exit.isFailure(oauthAttempt)).toBe(true);
  });

  test("bounds queue priorities to their sortable encoding", () => {
    expect(() => Schema.decodeUnknownSync(QueuePriority)(-1)).toThrow();
    expect(() => Schema.decodeUnknownSync(QueuePriority)(1.5)).toThrow();
    expect(() => Schema.decodeUnknownSync(QueuePriority)(100_000_000)).toThrow();
    expect(Schema.decodeUnknownSync(QueuePriority)(99_999_999)).toBe(99_999_999);
  });

  test("requires safe integer minor-unit money values", () => {
    expect(() => Schema.decodeUnknownSync(Money)({ amountMinor: 10.5, currency: "USD" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Money)({
        amountMinor: Number.MAX_SAFE_INTEGER + 1,
        currency: "USD",
      }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(Money)({ amountMinor: -500, currency: "USD" })).toEqual({
      amountMinor: -500,
      currency: "USD",
    });
  });

  test("rejects values that cannot round-trip through DynamoDB", () => {
    expect(() =>
      Schema.decodeUnknownSync(Metadata)({ args: ["first", undefined, "third"] }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(Metadata)({ value: Number.NaN })).toThrow();
    expect(() => Schema.decodeUnknownSync(PersistedNumber)(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => Schema.decodeUnknownSync(PersistedNumber)(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
