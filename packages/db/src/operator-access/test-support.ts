import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { OperatorAccessGrant } from "../identity-federation/access.ts";
import { OrganizationOperatorAccessRecord } from "../records/operator-access.ts";

const TEST_GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";

/** The grant an authorizer admits an administrator under for `openOperatorAccessRecord`. */
export function operatorAccessGrant(organizationId: string): OperatorAccessGrant {
  const decode = Schema.decodeUnknownSync(Ulid);
  return {
    expiresAt: "2100-01-01T00:00:00.000Z",
    grantId: decode(TEST_GRANT_ID),
    organizationId: decode(organizationId),
  };
}

/**
 * An open operator access record, for tests that act as a platform administrator on an
 * organization's tenant data. It expires in 2100 unless `expiresAt` says otherwise.
 */
export function openOperatorAccessRecord(input: {
  readonly expiresAt?: string;
  readonly organizationId: string;
  readonly principalId: string;
}) {
  return Schema.decodeUnknownSync(OrganizationOperatorAccessRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: input.expiresAt ?? "2100-01-01T00:00:00.000Z",
        grantId: Schema.decodeUnknownSync(Ulid)(TEST_GRANT_ID),
        openedAt: "2026-01-01T00:00:00.000Z",
        organizationId: input.organizationId,
        principalId: input.principalId,
        reason: "Test support",
        state: { kind: "open" },
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization-operator-access" as const,
    }),
  );
}

export { DYNAMODB_LOCAL_ENDPOINT, localPlatformTables } from "./local-dynamodb.fixture.ts";
