import { describe, expect, test } from "bun:test";
import {
  PersistenceError,
  makeDynamoDatabase,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  type PersistenceIdentity,
  type PersistenceInvocation,
  type TenancyPersistence,
} from "./index.ts";
import { humanPrincipalRecord } from "./tenancy-test-support.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";

const FOUNDER = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const ACTOR = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const TARGET_MEMBER = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const TARGET_OWNER = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const NEWCOMER = "01ARZ3NDEKTSV4RRFFQ69G5FA4";

type Caller = "owner" | "admin" | "billing" | "member" | "viewer" | "platform-admin" | "api-key";
type Outcome = "allowed" | "insufficient_role" | "organization_scope_violation";

interface Fixture {
  readonly identity: PersistenceIdentity;
  readonly memberInvitationId: string;
  readonly organizationId: string;
  readonly ownerInvitationId: string;
  readonly service: TenancyPersistence;
}

let sequence = 0;

function invocation<Body>(
  body: Body,
  identity: PersistenceIdentity,
  options: { readonly id?: string; readonly organizationId?: string } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity,
    idempotencyKey: `role-enforcement-${++sequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: {},
    scope: options.organizationId ? { organizationId: options.organizationId } : {},
  };
}

async function fixture(caller: Caller): Promise<Fixture> {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const [id, email] of [
    [FOUNDER, "founder@example.com"],
    [ACTOR, "actor@example.com"],
    [TARGET_MEMBER, "member@example.com"],
    [TARGET_OWNER, "owner@example.com"],
    [NEWCOMER, "newcomer@example.com"],
  ] as const) {
    fake.put(tables.control, humanPrincipalRecord(id, email));
  }
  const service = makeTenancyPersistence({ database: makeDynamoDatabase(fake.client, tables) });
  const founder: PersistenceIdentity = { principalId: FOUNDER, scopes: ["platform:*"] };
  const organization = await service.organizations.create(
    invocation({ name: `Roles ${caller} ${++sequence}` }, founder),
  );
  const organizationId = organization.id;
  const add = (principalId: string, role: "admin" | "billing" | "member" | "owner" | "viewer") =>
    service.organizationMembers.add(invocation({ principalId, role }, founder, { organizationId }));
  await add(TARGET_MEMBER, "member");
  await add(TARGET_OWNER, "owner");
  if (caller !== "platform-admin" && caller !== "api-key") await add(ACTOR, caller);
  const memberInvitation = await service.organizationInvitations.create(
    invocation({ email: "invited-member@example.com", role: "member" }, founder, {
      organizationId,
    }),
  );
  const ownerInvitation = await service.organizationInvitations.create(
    invocation({ email: "invited-owner@example.com", role: "owner" }, founder, { organizationId }),
  );
  // Production identities carry the organization selected by the request scope header.
  const identity: PersistenceIdentity = {
    authentication: caller === "api-key" ? "api-credential" : "tenant-jwt",
    organizationIds: [organizationId],
    // The authenticator admits a non-member administrator only under open operator access.
    ...(caller === "platform-admin"
      ? {
          operatorAccess: { grantId: "01ARZ3NDEKTSV4RRFFQ69G5ZZZ", organizationId },
          platformRole: "administrator" as const,
        }
      : {}),
    principalId: ACTOR,
    scopes: ["projects:read", "projects:write", "members:write", "invitations:write"],
  };
  return {
    identity,
    memberInvitationId: memberInvitation.id,
    organizationId,
    ownerInvitationId: ownerInvitation.id,
    service,
  };
}

const OPERATIONS = {
  "read organization resources": ({ identity, organizationId, service }) =>
    service.authorize(invocation(undefined, identity, { organizationId }), "listProjects", false),
  "mutate organization resources": ({ identity, organizationId, service }) =>
    service.authorize(invocation({}, identity, { organizationId }), "createProject", true),
  "list members": ({ identity, organizationId, service }) =>
    service.organizationMembers.list(invocation(undefined, identity, { organizationId })),
  "add member": ({ identity, organizationId, service }) =>
    service.organizationMembers.add(
      invocation({ principalId: NEWCOMER, role: "member" }, identity, { organizationId }),
    ),
  "add owner": ({ identity, organizationId, service }) =>
    service.organizationMembers.add(
      invocation({ principalId: NEWCOMER, role: "owner" }, identity, { organizationId }),
    ),
  "change member role": ({ identity, organizationId, service }) =>
    service.organizationMembers.update(
      invocation({ role: "viewer" }, identity, { id: TARGET_MEMBER, organizationId }),
    ),
  "promote member to owner": ({ identity, organizationId, service }) =>
    service.organizationMembers.update(
      invocation({ role: "owner" }, identity, { id: TARGET_MEMBER, organizationId }),
    ),
  "change owner role": ({ identity, organizationId, service }) =>
    service.organizationMembers.update(
      invocation({ role: "admin" }, identity, { id: TARGET_OWNER, organizationId }),
    ),
  "remove member": ({ identity, organizationId, service }) =>
    service.organizationMembers.remove(
      invocation({}, identity, { id: TARGET_MEMBER, organizationId }),
    ),
  "remove owner": ({ identity, organizationId, service }) =>
    service.organizationMembers.remove(
      invocation({}, identity, { id: TARGET_OWNER, organizationId }),
    ),
  "list invitations": ({ identity, organizationId, service }) =>
    service.organizationInvitations.list(invocation(undefined, identity, { organizationId })),
  "invite member": ({ identity, organizationId, service }) =>
    service.organizationInvitations.create(
      invocation({ email: "new-member@example.com", role: "member" }, identity, {
        organizationId,
      }),
    ),
  "invite owner": ({ identity, organizationId, service }) =>
    service.organizationInvitations.create(
      invocation({ email: "new-owner@example.com", role: "owner" }, identity, {
        organizationId,
      }),
    ),
  "admit member invitation": ({ identity, organizationId, service }) =>
    service.authorize(
      invocation({ email: "new-member@example.com", role: "member" }, identity, {
        organizationId,
      }),
      "createOrganizationInvitation",
      true,
    ),
  "admit owner invitation": ({ identity, organizationId, service }) =>
    service.authorize(
      invocation({ email: "new-owner@example.com", role: "owner" }, identity, {
        organizationId,
      }),
      "createOrganizationInvitation",
      true,
    ),
  "revoke member invitation": ({ identity, memberInvitationId, organizationId, service }) =>
    service.organizationInvitations.revoke(
      invocation({}, identity, { id: memberInvitationId, organizationId }),
    ),
  "revoke owner invitation": ({ identity, ownerInvitationId, organizationId, service }) =>
    service.organizationInvitations.revoke(
      invocation({}, identity, { id: ownerInvitationId, organizationId }),
    ),
  "update organization": ({ identity, organizationId, service }) =>
    service.organizations.update(
      invocation({ name: "Renamed" }, identity, { id: organizationId, organizationId }),
    ),
} satisfies Record<string, (fixture: Fixture) => Promise<unknown>>;

type Operation = keyof typeof OPERATIONS;

const A = "allowed";
const R = "insufficient_role";

/** Columns: owner, admin, billing, member, viewer, platform-admin, api-key. */
const EXPECTED: Record<Operation, readonly Outcome[]> = {
  "read organization resources": [A, A, A, A, A, A, A],
  "mutate organization resources": [A, A, R, R, R, A, A],
  "list members": [A, A, A, A, A, A, R],
  "add member": [A, A, R, R, R, A, R],
  "add owner": [A, R, R, R, R, A, R],
  "change member role": [A, A, R, R, R, A, R],
  "promote member to owner": [A, R, R, R, R, A, R],
  "change owner role": [A, R, R, R, R, A, R],
  "remove member": [A, A, R, R, R, A, R],
  "remove owner": [A, R, R, R, R, A, R],
  "list invitations": [A, A, R, R, R, A, R],
  "invite member": [A, A, R, R, R, A, R],
  "invite owner": [A, R, R, R, R, A, R],
  "admit member invitation": [A, A, R, R, R, A, R],
  "admit owner invitation": [A, R, R, R, R, A, R],
  "revoke member invitation": [A, A, R, R, R, A, R],
  "revoke owner invitation": [A, R, R, R, R, A, R],
  "update organization": [A, R, R, R, R, A, R],
};

const CALLERS: readonly Caller[] = [
  "owner",
  "admin",
  "billing",
  "member",
  "viewer",
  "platform-admin",
  "api-key",
];

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return error instanceof PersistenceError ? error.code : String(error);
  }
}

describe("organization role enforcement", () => {
  for (const [operation, expected] of Object.entries(EXPECTED) as [
    Operation,
    readonly Outcome[],
  ][]) {
    test(operation, async () => {
      const observed: Record<string, string | undefined> = {};
      for (const caller of CALLERS) {
        const context = await fixture(caller);
        observed[caller] = await outcome(() => OPERATIONS[operation](context));
      }
      expect(observed).toEqual(
        Object.fromEntries(CALLERS.map((caller, index) => [caller, expected[index]])),
      );
    });
  }
});
