import { describe, expect, test } from "bun:test";
import {
  AuditEventRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createOperationalReadService,
  makeAesGcmOperationalCursorCodec,
  type OperationalReadInvocation,
} from "./operational-reads.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OWNER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ADMIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

function auditEvent(input: {
  readonly action: string;
  readonly actorId: string;
  readonly environmentId?: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly organizationId?: string;
  readonly resourceId: string;
}) {
  return Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      data: {
        action: input.action,
        actor: { id: input.actorId, type: "principal" as const },
        ...(input.environmentId
          ? { environmentId: input.environmentId, projectId: PROJECT_ID }
          : {}),
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        organizationId: input.organizationId ?? ORGANIZATION_ID,
        resourceId: input.resourceId,
        resourceType: "project",
      },
      itemType: "audit-event" as const,
    }),
  ) as PlatformRecord;
}

const records: readonly PlatformRecord[] = [
  withCanonicalRecordKeys({
    data: { id: ORGANIZATION_ID },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord,
  auditEvent({
    action: "organization.created",
    actorId: OWNER_ID,
    eventId: "01J0000000000000000000000A",
    occurredAt: "2026-07-25T12:00:00.000Z",
    resourceId: ORGANIZATION_ID,
  }),
  auditEvent({
    action: "project.created",
    actorId: OWNER_ID,
    eventId: "01J0000000000000000000000B",
    occurredAt: "2026-07-25T12:01:00.000Z",
    resourceId: PROJECT_ID,
  }),
  auditEvent({
    action: "project.updated",
    actorId: ADMIN_ID,
    eventId: "01J0000000000000000000000C",
    occurredAt: "2026-07-25T12:02:00.000Z",
    resourceId: PROJECT_ID,
  }),
  auditEvent({
    action: "organization.updated",
    actorId: ADMIN_ID,
    eventId: "01J0000000000000000000000D",
    occurredAt: "2026-07-25T12:03:00.000Z",
    resourceId: ORGANIZATION_ID,
  }),
  auditEvent({
    action: "credential.read",
    actorId: ADMIN_ID,
    environmentId: ENVIRONMENT_ID,
    eventId: "01J0000000000000000000000E",
    occurredAt: "2026-07-25T12:04:00.000Z",
    resourceId: PROJECT_ID,
  }),
  auditEvent({
    action: "organization.created",
    actorId: OWNER_ID,
    eventId: "01J0000000000000000000000F",
    occurredAt: "2026-07-25T12:05:00.000Z",
    organizationId: OTHER_ORGANIZATION_ID,
    resourceId: OTHER_ORGANIZATION_ID,
  }),
];

/** Exact-key reads plus newest-first prefix queries over a fixed record set. */
function database(items: readonly PlatformRecord[]): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async (_table, wanted) =>
      items.find((item) => item.pk === wanted.pk && item.sk === wanted.sk),
    putRecord: async () => {},
    queryRecords: async (_table, input) => {
      const values = input.ExpressionAttributeValues ?? {};
      const ordered = items
        .filter(
          (item) =>
            item.pk === values[":pk"] && item.sk.startsWith(String(values[":prefix"] ?? "")),
        )
        .toSorted((left, right) => right.sk.localeCompare(left.sk));
      const start = input.ExclusiveStartKey
        ? ordered.findIndex((item) => item.sk === input.ExclusiveStartKey?.sk) + 1
        : 0;
      const page = ordered.slice(start, start + (input.Limit ?? ordered.length));
      const last = page.at(-1);
      return {
        items: page,
        ...(last && start + page.length < ordered.length
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      };
    },
    transactWrite: async () => {},
  };
}

const service = createOperationalReadService({
  cursorCodec: makeAesGcmOperationalCursorCodec(Buffer.alloc(32, 7)),
  database: database(records),
});

function invocation(
  query: OperationalReadInvocation["query"] = {},
  overrides: Partial<OperationalReadInvocation> = {},
): OperationalReadInvocation {
  return {
    id: ORGANIZATION_ID,
    identity: {
      organizationIds: [ORGANIZATION_ID],
      principalId: OWNER_ID,
      scopes: ["audit:read"],
    },
    query,
    scope: { organizationId: ORGANIZATION_ID },
    ...overrides,
  };
}

async function actions(query: OperationalReadInvocation["query"] = {}) {
  return (await service.listOrganizationAuditEvents(invocation(query))).items.map(
    (item) => item.action,
  );
}

describe("organization audit reads", () => {
  test("lists only organization-level events of the requested organization, newest first", async () => {
    const page = await service.listOrganizationAuditEvents(invocation());

    expect(page.items.map((item) => item.action)).toEqual([
      "organization.updated",
      "project.updated",
      "project.created",
      "organization.created",
    ]);
    expect(page.items[0] as unknown).toEqual({
      action: "organization.updated",
      actor: { id: ADMIN_ID, type: "principal" },
      id: "01J0000000000000000000000D",
      occurredAt: "2026-07-25T12:03:00.000Z",
      organizationId: ORGANIZATION_ID,
      resourceId: ORGANIZATION_ID,
      resourceType: "project",
    });
    expect(page.nextCursor).toBeUndefined();
  });

  test("applies the environment audit list filters", async () => {
    expect(await actions({ actor: ADMIN_ID })).toEqual(["organization.updated", "project.updated"]);
    expect(await actions({ resource: PROJECT_ID })).toEqual(["project.updated", "project.created"]);
    expect(await actions({ event: "organization.created" })).toEqual(["organization.created"]);
    expect(
      await actions({ since: "2026-07-25T12:01:00.000Z", until: "2026-07-25T12:03:00.000Z" }),
    ).toEqual(["project.updated", "project.created"]);
    expect(
      service.listOrganizationAuditEvents(
        invocation({ since: "2026-07-25T12:03:00.000Z", until: "2026-07-25T12:01:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_time_range", status: 400 });
  });

  test("pages with filter-bound encrypted cursors", async () => {
    const first = await service.listOrganizationAuditEvents(invocation({ limit: "3" }));
    expect(first.items.map((item) => item.action)).toEqual([
      "organization.updated",
      "project.updated",
      "project.created",
    ]);
    const second = await service.listOrganizationAuditEvents(
      invocation({ cursor: first.nextCursor, limit: "3" }),
    );
    expect(second.items.map((item) => item.action)).toEqual(["organization.created"]);
    expect(
      service.listOrganizationAuditEvents(
        invocation({ cursor: first.nextCursor, event: "project.created", limit: "3" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("enforces organization scope and erased-organization semantics", async () => {
    expect(
      service.listOrganizationAuditEvents(invocation({}, { scope: {} })),
    ).rejects.toMatchObject({ code: "missing_scope", status: 400 });
    expect(
      service.listOrganizationAuditEvents(
        invocation({}, { scope: { organizationId: OTHER_ORGANIZATION_ID } }),
      ),
    ).rejects.toMatchObject({ code: "organization_scope_violation", status: 403 });
    expect(
      service.listOrganizationAuditEvents(
        invocation(
          {},
          {
            id: OTHER_ORGANIZATION_ID,
            scope: { organizationId: OTHER_ORGANIZATION_ID },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "organization_scope_violation", status: 403 });
    expect(
      service.listOrganizationAuditEvents(
        invocation(
          {},
          {
            id: OTHER_ORGANIZATION_ID,
            identity: {
              organizationIds: [OTHER_ORGANIZATION_ID],
              principalId: OWNER_ID,
              scopes: ["platform:admin"],
            },
            scope: { organizationId: OTHER_ORGANIZATION_ID },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "organization_erased", status: 410 });
  });
});
