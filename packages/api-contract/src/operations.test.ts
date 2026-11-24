import { expect, test } from "bun:test";
import { Schema } from "effect";
import { OPERATIONS_API_SCHEMAS } from "./operations.ts";

test("an organization audit event acted by a directory token decodes through the public response", () => {
  const event = {
    action: "organization-member.added",
    actor: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", type: "directory-token" },
    changes: { principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", role: "member", source: "scim" },
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    occurredAt: "2026-10-09T08:00:00.000Z",
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    resourceId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    resourceType: "organization-member",
  };

  const decoded: unknown = Schema.decodeUnknownSync(
    OPERATIONS_API_SCHEMAS.OrganizationAuditEventPageResponse,
  )({ items: [event] });

  expect(decoded).toEqual({ items: [event] });
});
