import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  PersistenceError,
  PrincipalRecord,
  makeTenancyPersistence,
  withCanonicalRecordKeys,
  type PersistenceIdentity,
  type PersistenceInvocation,
} from "./index.ts";
import { humanPrincipalRecord, makeTenancyTestDatabase } from "./tenancy-test-support.ts";

const OWNER = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const ADMINISTRATOR = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const CUSTOMER = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const ADMINISTRATOR_EMAIL = "operator@example.test";
let sequence = 0;

function invocation<Body>(
  body: Body,
  identity: PersistenceIdentity,
  options: { readonly id?: string; readonly organizationId?: string } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity,
    idempotencyKey: `self-membership-${++sequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: {},
    scope: options.organizationId ? { organizationId: options.organizationId } : {},
  };
}

async function organizationUnderAccess() {
  const store = makeTenancyTestDatabase();
  const service = makeTenancyPersistence({
    database: store.database,
    generateInvitationToken: (invitationId) => `invite-${invitationId}-secret`,
  });
  await store.database.putRecord(humanPrincipalRecord(CUSTOMER, "customer@example.test"));
  await store.database.putRecord(
    Schema.decodeUnknownSync(PrincipalRecord)(
      withCanonicalRecordKeys({
        data: {
          ...humanPrincipalRecord(ADMINISTRATOR, ADMINISTRATOR_EMAIL).data,
          platformRole: "administrator",
        },
        itemType: "principal" as const,
      }),
    ),
  );
  const owner: PersistenceIdentity = { principalId: OWNER, scopes: ["platform:*"] };
  const { id: organizationId } = await service.organizations.create(
    invocation({ name: "Customer" }, owner),
  );
  const administrator: PersistenceIdentity = {
    authentication: "tenant-jwt",
    operatorAccess: { grantId: "01ARZ3NDEKTSV4RRFFQ69G5ZZZ", organizationId },
    organizationIds: [organizationId],
    platformRole: "administrator",
    principalId: ADMINISTRATOR,
    scopes: ["members:write", "invitations:write", "invitations:accept"],
  };
  return { administrator, organizationId, owner, service };
}

async function code(run: () => Promise<unknown>) {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return error instanceof PersistenceError ? error.code : String(error);
  }
}

describe("operator access self membership", () => {
  test("refuses an administrator adding themselves and allows adding someone else", async () => {
    const { administrator, organizationId, service } = await organizationUnderAccess();
    const add = (principalId: string) =>
      code(() =>
        service.organizationMembers.add(
          invocation({ principalId, role: "owner" }, administrator, { organizationId }),
        ),
      );

    expect(await add(ADMINISTRATOR)).toBe("operator_access_self_membership");
    expect(await add(CUSTOMER)).toBe("allowed");
  });

  test("refuses an administrator inviting their own address in any case", async () => {
    const { administrator, organizationId, service } = await organizationUnderAccess();
    const invite = (email: string) =>
      code(() =>
        service.organizationInvitations.create(
          invocation({ email, role: "member" }, administrator, { organizationId }),
        ),
      );

    expect(await invite("Operator@Example.test")).toBe("operator_access_self_membership");
    expect(await invite("customer@example.test")).toBe("allowed");
  });

  test("refuses an administrator accepting an invitation they sent themselves", async () => {
    const { administrator, organizationId, owner, service } = await organizationUnderAccess();
    // An invitation an administrator sent to an address they later took as their own.
    const selfSent = await service.organizationInvitations.create(
      invocation({ email: "spare@example.test", role: "owner" }, administrator, {
        organizationId,
      }),
    );
    const ownerSent = await service.organizationInvitations.create(
      invocation({ email: ADMINISTRATOR_EMAIL, role: "member" }, owner, { organizationId }),
    );
    const accept = (invitation: { readonly id: string; readonly token: string }) =>
      code(() =>
        service.organizationInvitations.accept(
          invocation(
            { token: invitation.token },
            { principalId: ADMINISTRATOR, scopes: ["invitations:accept"] },
            { id: invitation.id },
          ),
        ),
      );

    expect(await accept(selfSent)).toBe("operator_access_self_membership");
    expect(await accept(ownerSent)).toBe("allowed");
  });
});
