import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "./ids.ts";
import { ProviderConnectionRecord } from "./records/control.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { uniqueClaimRequirements, uniqueOwnerAttributes } from "./unique-claims.ts";

const ids = Array.from({ length: 4 }, (_, index) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`),
);

const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
  withCanonicalRecordKeys({
    itemType: "provider-connection" as const,
    data: {
      authMethod: "oauth" as const,
      createdAt: "2026-07-24T00:00:00.000Z",
      environmentId: ids[0]!,
      externalAccountId: "account-1",
      id: ids[1]!,
      organizationId: ids[2]!,
      projectId: ids[3]!,
      providerKey: "salesforce",
      scopes: ["read"],
      status: "active" as const,
      updatedAt: "2026-07-24T00:00:00.000Z",
      version: 0,
    },
  }),
);

describe("provider connection unique claims", () => {
  test("releases the external account identity after disconnect", () => {
    const disconnected = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        ...connection,
        data: { ...connection.data, status: "disconnected" as const, version: 1 },
      }),
    );

    expect(uniqueClaimRequirements(connection)).toHaveLength(1);
    expect(uniqueClaimRequirements(disconnected)).toEqual([]);
    expect(uniqueOwnerAttributes(connection)).toMatchObject({ status: "active" });
  });
});
