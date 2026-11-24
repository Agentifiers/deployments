import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "./client-types.ts";
import { federatedGrantRecord } from "./identity-federation/access.ts";
import { CONNECTION, ISSUER, providerRecord } from "./identity-federation/test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys } from "./keys.ts";
import { openOperatorAccessRecord, operatorAccessGrant } from "./operator-access/test-support.ts";
import { authorizePlatformHumanScope } from "./platform-human-authorization.ts";
import type { PlatformRecord } from "./records/index.ts";

const ids = {
  environmentId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
  organizationId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  principalId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
  projectId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
} as const;
const TOKEN_SESSION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB1");

function storageKey(table: string, key: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}

function fixture(platformAdministrator = false) {
  const records = new Map<string, PlatformRecord>();
  const principalKey = {
    pk: `PRINCIPAL#${ids.principalId}`,
    sk: `PRINCIPAL#${ids.principalId}`,
  };
  records.set(storageKey("control", principalKey), {
    ...principalKey,
    data: {
      id: ids.principalId,
      kind: "human",
      ...(platformAdministrator ? { platformRole: "administrator" } : {}),
      status: "active",
    },
    itemType: "principal",
  } as unknown as PlatformRecord);
  const environmentKey = { pk: "environment-pk", sk: "environment-sk" };
  const claimKey = Keys.control.uniqueClaim("environment-id", ids.environmentId);
  records.set(storageKey("control", claimKey), {
    ...claimKey,
    data: {
      namespace: "environment-id",
      ownerId: ids.environmentId,
      ownerItemType: "environment",
      ownerPk: environmentKey.pk,
      ownerSk: environmentKey.sk,
    },
    itemType: "unique-claim",
  } as unknown as PlatformRecord);
  records.set(storageKey("control", environmentKey), {
    ...environmentKey,
    data: {
      id: ids.environmentId,
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      status: "active",
    },
    itemType: "environment",
  } as unknown as PlatformRecord);
  const membershipKey = {
    pk: `ORG#${ids.organizationId}`,
    sk: `ORGANIZATION-MEMBER#${ids.principalId}`,
  };
  records.set(storageKey("control", membershipKey), {
    ...membershipKey,
    data: {
      organizationId: ids.organizationId,
      principalId: ids.principalId,
      role: "member",
      status: "active",
    },
    itemType: "organization-member",
  } as unknown as PlatformRecord);
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (table, key) => records.get(storageKey(table, key)),
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
  };
  const put = (record: PlatformRecord) => records.set(storageKey("control", record), record);
  return { database, membershipKey, principalKey, put, records };
}

describe("platform human scope authorization", () => {
  it("requires an active live membership for ordinary platform principals", async () => {
    const context = fixture();
    expect(await authorizePlatformHumanScope(context.database, ids)).toEqual({
      kind: "member",
      role: "member",
    });
    context.records.delete(storageKey("control", context.membershipKey));
    expect(await authorizePlatformHumanScope(context.database, ids)).toEqual({ kind: "denied" });
  });

  it("admits a platform administrator without membership only under open operator access", async () => {
    const context = fixture(true);
    context.records.delete(storageKey("control", context.membershipKey));
    expect(await authorizePlatformHumanScope(context.database, ids)).toEqual({
      kind: "operator-access-required",
    });
    context.put(openOperatorAccessRecord(ids));
    expect(await authorizePlatformHumanScope(context.database, ids)).toEqual({
      kind: "platform-administrator",
      operatorAccess: operatorAccessGrant(ids.organizationId),
    });
  });

  it("rejects disabled principals and mismatched environment hierarchy", async () => {
    const disabled = fixture();
    const principal = disabled.records.get(storageKey("control", disabled.principalKey))!;
    disabled.records.set(storageKey("control", disabled.principalKey), {
      ...principal,
      data: { ...principal.data, status: "disabled" },
    } as PlatformRecord);
    expect(await authorizePlatformHumanScope(disabled.database, ids)).toEqual({ kind: "denied" });

    const mismatch = fixture();
    expect(
      await authorizePlatformHumanScope(mismatch.database, {
        ...ids,
        projectId: Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
      }),
    ).toEqual({ kind: "denied" });
  });

  it("requires the token session's federated grant when the organization enforces SSO", async () => {
    const context = fixture();
    context.put(
      providerRecord({
        organizationId: ids.organizationId,
        state: { enforcement: "required", kind: "active" },
      }),
    );
    const withSession = { ...ids, tokenSessionId: TOKEN_SESSION_ID };
    expect(await authorizePlatformHumanScope(context.database, withSession)).toEqual({
      kind: "sso-required",
    });

    const authenticatedAt = new Date();
    context.put(
      federatedGrantRecord({
        authentication: {
          authenticatedAt: authenticatedAt.toISOString(),
          connectionId: CONNECTION,
          issuer: ISSUER,
          method: "federated",
          organizationId: ids.organizationId,
          subject: "okta-user",
        },
        createdAt: authenticatedAt.toISOString(),
        principalId: ids.principalId,
        tokenSessionExpiresAt: new Date(authenticatedAt.getTime() + 3_600_000).toISOString(),
        tokenSessionId: TOKEN_SESSION_ID,
      }),
    );
    expect(await authorizePlatformHumanScope(context.database, withSession)).toEqual({
      kind: "member",
      role: "member",
    });
    expect(await authorizePlatformHumanScope(context.database, ids)).toEqual({
      kind: "sso-required",
    });
  });
});
