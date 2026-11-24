import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateTenantErasureRequest,
  GOVERNANCE_API_ROUTES,
  GOVERNANCE_API_SCHEMAS,
  ImmutableAuditExportResponse,
  OrganizationRetentionPolicyResponse,
  makePublicOpenApiSpec,
  TenantErasureSummary,
  UpdateOrganizationRetentionPolicyRequest,
} from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REQUESTED_AT = "2026-07-25T12:00:00.000Z";
const STARTED_AT = "2026-07-25T12:00:01.000Z";
const COMPLETED_AT = "2026-07-25T12:01:00.000Z";

const publicOpenApiSpec = makePublicOpenApiSpec();

function operation(method: string, path: string) {
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return publicOpenApiSpec.paths[openApiPath]?.[method.toLowerCase()];
}

describe("governance API contract", () => {
  test("configures every governed data class with bounded whole-day retention", () => {
    expect(
      Schema.decodeUnknownSync(OrganizationRetentionPolicyResponse)({
        artifacts: 30,
        audit: 2_555,
        createdAt: REQUESTED_AT,
        events: 90,
        messages: 365,
        organizationId: ORGANIZATION_ID,
        runs: 365,
        threads: 365,
        updatedAt: REQUESTED_AT,
        updatedByPrincipalId: JOB_ID,
        version: 1,
      }),
    ).toMatchObject({ artifacts: 30, audit: 2_555, threads: 365 });

    expect(
      Schema.decodeUnknownSync(UpdateOrganizationRetentionPolicyRequest)({ messages: 60 }),
    ).toEqual({ messages: 60 });
    expect(() => Schema.decodeUnknownSync(UpdateOrganizationRetentionPolicyRequest)({})).toThrow(
      "change at least one resource",
    );
    expect(() =>
      Schema.decodeUnknownSync(UpdateOrganizationRetentionPolicyRequest)({ events: 1.5 }),
    ).toThrow("must be an integer");
    expect(() =>
      Schema.decodeUnknownSync(UpdateOrganizationRetentionPolicyRequest)({ audit: 364 }),
    ).toThrow("must be at least 365");
    expect(() =>
      Schema.decodeUnknownSync(UpdateOrganizationRetentionPolicyRequest)({ messages: 3_651 }),
    ).toThrow("must not exceed 3650");
  });

  test("requires deliberate tenant erasure confirmation", () => {
    expect(
      Schema.decodeUnknownSync(CreateTenantErasureRequest)({
        confirmation: "ERASE",
      }),
    ).toMatchObject({ confirmation: "ERASE" });
    expect(() =>
      Schema.decodeUnknownSync(CreateTenantErasureRequest)({ confirmation: "erase" }),
    ).toThrow();
  });

  test("makes completed audit exports independently integrity-verifiable and immutable", () => {
    const completed = {
      completedAt: COMPLETED_AT,
      createdAt: REQUESTED_AT,
      id: JOB_ID,
      kind: "audit-export",
      organizationId: ORGANIZATION_ID,
      output: {
        archiveDownloadUrl: "https://downloads.example.test/audit-records.jsonl",
        archiveDownloadUrlExpiresAt: "2026-07-25T13:01:00.000Z",
        archiveFileName: "audit-records.jsonl",
        archiveSha256: "c".repeat(64),
        archiveSizeBytes: 3_072,
        contentType: "application/json",
        downloadUrl: "https://downloads.example.test/audit.zip",
        downloadUrlExpiresAt: "2026-07-25T13:01:00.000Z",
        fileName: "audit-manifest.json",
        immutable: true,
        sha256: "a".repeat(64),
        sizeBytes: 4_096,
      },
      startedAt: STARTED_AT,
      status: "completed",
      summary: {
        recordCount: 42,
        retainedUntil: "2033-07-24T12:01:00.000Z",
        rootHash: "b".repeat(64),
      },
      updatedAt: COMPLETED_AT,
      version: 3,
    };

    expect(
      Schema.decodeUnknownSync(ImmutableAuditExportResponse)(completed as unknown) as unknown,
    ).toEqual(completed);
    expect(() =>
      Schema.decodeUnknownSync(ImmutableAuditExportResponse)({
        ...completed,
        output: { ...completed.output, immutable: false },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ImmutableAuditExportResponse)({
        ...completed,
        output: { ...completed.output, sha256: "sha256:not-a-digest" },
      }),
    ).toThrow("64-character SHA-256");
    const { output: _output, ...completedWithoutOutput } = completed;
    expect(() =>
      Schema.decodeUnknownSync(ImmutableAuditExportResponse)(completedWithoutOutput),
    ).toThrow("must include output metadata");
  });

  test("publishes organization-scoped asynchronous governance operations", () => {
    expect(GOVERNANCE_API_ROUTES.map(({ name }) => name)).toEqual([
      "getOrganizationRetentionPolicy",
      "updateOrganizationRetentionPolicy",
      "createTenantDataExport",
      "getTenantDataExport",
      "createTenantErasure",
      "getTenantErasure",
      "createImmutableAuditExport",
      "getImmutableAuditExport",
      "listGovernanceOperations",
    ]);

    for (const route of GOVERNANCE_API_ROUTES) {
      expect(route.path).toStartWith("/v1/organizations/:id/");
      expect(route.authentication).toBe("platform-bearer");
      expect(route.scopeHeaders).toBe("organization");
      expect(route.tag).toBe("Governance");
      expect(GOVERNANCE_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(GOVERNANCE_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
    }

    expect(
      GOVERNANCE_API_ROUTES.find(({ name }) => name === "createTenantDataExport"),
    ).toMatchObject({
      idempotency: "required",
      successStatus: 202,
    });
    expect(GOVERNANCE_API_ROUTES.find(({ name }) => name === "createTenantErasure")).toMatchObject({
      idempotency: "required",
      successStatus: 202,
    });
    expect(
      GOVERNANCE_API_ROUTES.find(({ name }) => name === "createImmutableAuditExport"),
    ).toMatchObject({
      idempotency: "required",
      successStatus: 202,
    });
  });

  test("generates governance OpenAPI operations with write authorization and idempotency", () => {
    const updateRetention = operation("PATCH", "/v1/organizations/:id/retention-policy") as {
      readonly description?: string;
      readonly parameters?: readonly Readonly<Record<string, unknown>>[];
      readonly tags?: readonly string[];
    };
    const createExport = operation("POST", "/v1/organizations/:id/data-exports") as {
      readonly responses?: Readonly<Record<string, unknown>>;
    };

    expect(updateRetention.description).toContain("governance:write");
    expect(updateRetention.tags).toEqual(["Governance"]);
    expect(updateRetention.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "idempotency-key",
        required: true,
      }),
    );
    expect(createExport.responses).toHaveProperty("202");
    const getRetention = operation("GET", "/v1/organizations/:id/retention-policy") as {
      readonly responses?: Readonly<Record<string, unknown>>;
    };
    expect(getRetention.responses).toHaveProperty("410");
  });

  test("decodes operation history pages that mix every operation kind", () => {
    const base = {
      createdAt: REQUESTED_AT,
      id: JOB_ID,
      organizationId: ORGANIZATION_ID,
      status: "pending",
      updatedAt: REQUESTED_AT,
      version: 1,
    };
    const conversation = {
      counts: {
        automationsArchived: 0,
        emailMessagesErased: 2,
        emailThreadsErased: 1,
        ingressRecordsDeleted: 1,
        memoriesErased: 2,
        objectsStaged: 3,
        recordsDeleted: 4,
        runsCanceled: 0,
        streamsDeleted: 1,
        threadsErased: 1,
        threadsPlanned: 1,
      },
      createdAt: REQUESTED_AT,
      environmentId: ORGANIZATION_ID,
      id: JOB_ID,
      phase: "canonical",
      status: "running",
      updatedAt: REQUESTED_AT,
    };
    const page = {
      items: [
        { ...base, kind: "tenant-erasure" },
        { ...base, kind: "audit-export" },
        { ...base, kind: "tenant-export" },
        { ...conversation, kind: "thread-erasure", threadId: JOB_ID },
        { ...conversation, kind: "end-user-erasure" },
      ],
      nextCursor: "eyJpZCI6IngifQ",
    };
    const decodePage = Schema.decodeUnknownSync(
      GOVERNANCE_API_SCHEMAS.GovernanceOperationPageResponse,
      { onExcessProperty: "error" },
    );

    expect(decodePage(page)).toEqual(page as never);
    for (const item of [
      { ...base, kind: "retention-cleanup" },
      { ...base, kind: "tenant-export", status: "completed" },
      { ...conversation, kind: "thread-erasure" },
      { ...conversation, kind: "thread", threadId: JOB_ID },
      { ...conversation, endUserKey: `v1.${"a".repeat(43)}`, kind: "end-user-erasure" },
      { ...conversation, idempotencyKey: "request-1", kind: "end-user-erasure" },
      { ...conversation, kind: "end-user-erasure", requestedByPrincipalId: JOB_ID },
    ]) {
      expect(() => decodePage({ items: [item] })).toThrow();
    }

    const history = operation("GET", "/v1/organizations/:id/governance-operations") as {
      readonly description?: string;
      readonly parameters?: readonly Readonly<Record<string, unknown>>[];
      readonly responses?: Readonly<Record<string, unknown>>;
    };
    expect(history.description).toContain("governance:read");
    expect(history.responses).toHaveProperty("410");
    expect(history.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(["cursor", "kind", "limit", "status", "x-deployments-organization"]),
    );
    expect(history.parameters?.find((parameter) => parameter.name === "kind")?.schema).toEqual({
      enum: [
        "audit-export",
        "end-user-erasure",
        "tenant-erasure",
        "tenant-export",
        "thread-erasure",
      ],
      type: "string",
    });
  });

  test("reports the memory search backup expiry on completed tenant erasures when present", () => {
    const decodeSummary = Schema.decodeUnknownSync(TenantErasureSummary, {
      onExcessProperty: "error",
    });
    const summary = { auditRootHash: "a".repeat(64), recordsDeleted: 4 };
    const withMemorySearch = {
      ...summary,
      memorySearch: { backupsExpireBy: "2026-08-08T13:05:00.000Z" },
    };

    expect(decodeSummary(withMemorySearch)).toEqual(withMemorySearch);
    expect(decodeSummary(summary)).toEqual(summary);
    expect(() =>
      decodeSummary({ ...summary, memorySearch: { backupsExpireBy: "in 14 days" } }),
    ).toThrow();
  });
});
