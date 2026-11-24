import type { PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { sha256 } from "./canonical.ts";
import { makeGovernanceTenantExport } from "./governance-tenant-export.ts";
import type { GovernanceServiceContext } from "./service.ts";
import type {
  AppTableObject,
  GovernanceObjectReference,
  GovernanceOperation,
  GovernanceServiceOptions,
  TenantRecord,
} from "./types.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const appId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const now = "2026-10-09T00:00:00.000Z";
const exportPrefix = `apps/${appId}/exports/01ARZ3NDEKTSV4RRFFQ69G5FB9`;

const CSV_OBJECTS: Readonly<Record<string, string>> = {
  [`apps-bucket/${exportPrefix}/customers.csv`]: "id,name\n1,Ada\n2,Grace\n",
  [`apps-bucket/${exportPrefix}/orders.csv`]: "id,customer_id,total\n10,1,42.50\n",
};

const appRecord: TenantRecord = {
  record: {
    data: { id: appId, lifecycle: { liveReleaseId: null, state: "active" }, organizationId },
    itemType: "app",
    pk: `ORG#${organizationId}#APP#${appId}`,
    sk: `APP#${appId}`,
  } as unknown as PlatformRecord,
  table: "control",
};

function exportFixture(exportAppTables?: GovernanceServiceOptions["exportAppTables"]) {
  const written = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const stored = (reference: { readonly bucket: string; readonly key: string }) => {
    const body = CSV_OBJECTS[`${reference.bucket}/${reference.key}`];
    if (body === undefined) throw new Error(`missing ${reference.bucket}/${reference.key}`);
    return encoder.encode(body);
  };
  const context = {
    now: () => new Date(now),
    options: {
      allowedObjectBuckets: ["apps-bucket", "governance"],
      ...(exportAppTables ? { exportAppTables } : {}),
      objectStore: {
        find: async () => undefined,
        read: async (reference: { bucket: string; key: string }) => stored(reference),
        size: async (reference: { bucket: string; key: string }) => stored(reference).byteLength,
      },
      store: { updateOperation: async (next: GovernanceOperation) => next },
    },
    writeObject: async (
      _organization: string,
      _operation: string,
      name: string,
      body: Uint8Array,
    ) => {
      written.set(name, body);
      return {
        bucket: "governance",
        key: `governance/${organizationId}/${operationId}/${name}`,
        sha256: sha256(body),
        sizeBytes: body.byteLength,
        versionId: "v1",
      } satisfies GovernanceObjectReference;
    },
  } as unknown as GovernanceServiceContext;
  const operation: GovernanceOperation = {
    createdAt: now,
    id: operationId,
    idempotencyKey: "export",
    kind: "tenant-export",
    organizationId,
    requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    status: "running",
    updatedAt: now,
    version: 1,
  };
  return {
    run: () =>
      makeGovernanceTenantExport(context)(
        operation,
        [appRecord],
        () => undefined,
        async () => undefined,
      ),
    written,
  };
}

function exportedBlobs(body: Uint8Array | undefined) {
  return new TextDecoder()
    .decode(body)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { blob?: AppTableObject; bodyBase64?: string })
    .flatMap(({ blob, bodyBase64 }) =>
      blob && bodyBase64
        ? [
            {
              body: Buffer.from(bodyBase64, "base64").toString("utf8"),
              contentType: blob.contentType,
              key: blob.key,
            },
          ]
        : [],
    );
}

describe("tenant export of agent-built apps", () => {
  test("includes one CSV object per app table, written by the app export for this operation", async () => {
    const requests: unknown[] = [];
    const fixture = exportFixture(async ({ app, operationId: requested }) => {
      requests.push({ appId: app.data.id, operationId: requested });
      return ["orders", "customers"].map((table) => ({
        bucket: "apps-bucket",
        contentType: "text/csv; charset=utf-8",
        key: `${exportPrefix}/${table}.csv`,
      }));
    });

    const result = await fixture.run();

    expect({
      blobs: exportedBlobs(fixture.written.get("tenant.jsonl")),
      requests,
      summary: result.summary,
    }).toEqual({
      blobs: [
        {
          body: "id,name\n1,Ada\n2,Grace\n",
          contentType: "text/csv; charset=utf-8",
          key: `${exportPrefix}/customers.csv`,
        },
        {
          body: "id,customer_id,total\n10,1,42.50\n",
          contentType: "text/csv; charset=utf-8",
          key: `${exportPrefix}/orders.csv`,
        },
      ],
      requests: [{ appId, operationId }],
      summary: {
        blobCount: 2,
        excludedBlobBytes: 0,
        excludedBlobCount: 0,
        format: "deployments-ai-tenant-export/v1",
        recordCount: 1,
        totalBlobBytes: 54,
      },
    });
  });

  test("refuses a tenant with apps when it cannot export their tables or reads outside its buckets", async () => {
    const unconfigured = exportFixture();
    const outside = exportFixture(async () => [
      { bucket: "other-bucket", contentType: "text/csv; charset=utf-8", key: "orders.csv" },
    ]);

    const failures = await Promise.all(
      [unconfigured, outside].map((fixture) =>
        fixture.run().then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      ),
    );

    expect(failures).toEqual([
      "Tenant export found agent-built apps but cannot export their tables.",
      "App table other-bucket/orders.csv is outside the tenant governance boundary.",
    ]);
  });
});
