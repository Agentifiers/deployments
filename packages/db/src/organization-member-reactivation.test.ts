import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "./ids.ts";
import { key, makeTenancyPersistence, type PersistenceInvocation } from "./index.ts";
import { humanPrincipalRecord, makeTenancyTestDatabase } from "./tenancy-test-support.ts";

const OWNER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAT");
const ADDED_AT = "2026-07-25T12:00:00.000Z";
const REMOVED_AT = "2026-07-26T12:00:00.000Z";
const REJOINED_AT = "2026-07-27T12:00:00.000Z";
let invocationSequence = 0;

function invocation<Body>(
  body: Body,
  options: {
    readonly id?: string;
    readonly identity?: PersistenceInvocation["identity"];
    readonly organizationId?: string;
  } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity: options.identity ?? { principalId: OWNER_ID, scopes: ["platform:*"] },
    idempotencyKey: `organization-member-reactivation-test-${++invocationSequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: {},
    scope: options.organizationId ? { organizationId: options.organizationId } : {},
  };
}

async function removedMember() {
  const store = makeTenancyTestDatabase();
  let current = new Date(ADDED_AT);
  const service = makeTenancyPersistence({
    database: store.database,
    generateInvitationToken: (invitationId) => `invite-${invitationId}-secret`,
    now: () => current,
  });
  await store.database.putRecord(humanPrincipalRecord(MEMBER_ID, "returning@example.test"));
  const organization = await service.organizations.create(invocation({ name: "Rejoin org" }));
  const organizationId = organization.id;
  await service.organizationMembers.add(
    invocation({ principalId: MEMBER_ID, role: "viewer" }, { organizationId }),
  );
  current = new Date(REMOVED_AT);
  await service.organizationMembers.remove(invocation({}, { id: MEMBER_ID, organizationId }));
  current = new Date(REJOINED_AT);
  const storedMember = async () =>
    (
      await store.database.getRecord("control", {
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-MEMBER", MEMBER_ID),
      })
    )?.data;
  return { organizationId, service, storedMember };
}

describe("organization member reactivation", () => {
  test("a removed member who accepts a new invitation becomes active without removal fields", async () => {
    const { organizationId, service, storedMember } = await removedMember();
    const invitation = await service.organizationInvitations.create(
      invocation({ email: "returning@example.test", role: "member" }, { organizationId }),
    );

    const accepted = await service.organizationInvitations.accept(
      invocation(
        { token: invitation.token },
        {
          id: invitation.id,
          identity: { principalId: MEMBER_ID, scopes: ["invitations:accept"] },
        },
      ),
    );

    expect(accepted).toStrictEqual({
      createdAt: ADDED_AT,
      id: MEMBER_ID,
      joinedAt: REJOINED_AT,
      organizationId,
      primaryEmail: "returning@example.test",
      principalId: MEMBER_ID,
      role: "member",
      status: "active",
      updatedAt: REJOINED_AT,
      version: 3,
    });
    expect(await storedMember()).toStrictEqual({
      createdAt: ADDED_AT,
      joinedAt: REJOINED_AT,
      organizationId,
      principalId: MEMBER_ID,
      role: "member",
      status: "active",
      updatedAt: REJOINED_AT,
      version: 3,
    });
  });

  test("a removed member who is added again becomes active without removal fields", async () => {
    const { organizationId, service, storedMember } = await removedMember();

    const added = await service.organizationMembers.add(
      invocation({ principalId: MEMBER_ID, role: "admin" }, { organizationId }),
    );

    expect(added).toStrictEqual({
      createdAt: ADDED_AT,
      id: MEMBER_ID,
      joinedAt: REJOINED_AT,
      organizationId,
      primaryEmail: "returning@example.test",
      principalId: MEMBER_ID,
      role: "admin",
      status: "active",
      updatedAt: REJOINED_AT,
      version: 3,
    });
    expect(await storedMember()).toStrictEqual({
      createdAt: ADDED_AT,
      joinedAt: REJOINED_AT,
      organizationId,
      principalId: MEMBER_ID,
      role: "admin",
      status: "active",
      updatedAt: REJOINED_AT,
      version: 3,
    });
  });
});
