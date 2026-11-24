import { describe, expect, test } from "bun:test";
import {
  key,
  listOrganizationAuditEventPage,
  makeTenancyPersistence,
  type PersistenceInvocation,
} from "../index.ts";
import { humanPrincipalRecord, makeTenancyTestDatabase } from "../tenancy-test-support.ts";

const OWNER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const INVITEE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAS";
let invocationSequence = 0;

function invocation<Body>(
  body: Body,
  options: {
    readonly id?: string;
    readonly identity?: PersistenceInvocation["identity"];
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly environmentId?: string;
  } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity: options.identity ?? { principalId: OWNER_ID, scopes: ["platform:*"] },
    idempotencyKey: `organization-audit-test-${++invocationSequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: {},
    scope: {
      ...(options.environmentId ? { environmentId: options.environmentId } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
  };
}

async function organizationAudit(
  database: ReturnType<typeof makeTenancyTestDatabase>["database"],
  organizationId: string,
) {
  const page = await listOrganizationAuditEventPage(database, { limit: 100, organizationId });
  return page.items;
}

describe("organization audit log", () => {
  test("audits each organization administration mutation exactly once, newest first", async () => {
    const store = makeTenancyTestDatabase();
    const service = makeTenancyPersistence({
      database: store.database,
      generateInvitationToken: (invitationId) => `invite-${invitationId}-secret`,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    await store.database.putRecord(humanPrincipalRecord(MEMBER_ID, "member@example.test"));
    await store.database.putRecord(humanPrincipalRecord(INVITEE_ID, "invitee@example.test"));

    const organization = await service.organizations.create(invocation({ name: "Audit org" }));
    const scope = { organizationId: organization.id };
    await service.organizations.update(
      invocation({ name: "Audit org renamed" }, { ...scope, id: organization.id }),
    );
    await service.organizationMembers.add(
      invocation({ principalId: MEMBER_ID, role: "viewer" }, scope),
    );
    await service.organizationMembers.update(
      invocation({ role: "admin" }, { ...scope, id: MEMBER_ID }),
    );
    await service.organizationMembers.remove(invocation({}, { ...scope, id: MEMBER_ID }));
    const invitation = await service.organizationInvitations.create(
      invocation({ email: "invitee@example.test", role: "member" }, scope),
    );
    await service.organizationInvitations.accept(
      invocation(
        { token: invitation.token },
        {
          id: invitation.id,
          identity: { principalId: INVITEE_ID, scopes: ["invitations:accept"] },
        },
      ),
    );
    const revocable = await service.organizationInvitations.create(
      invocation({ email: "declined@example.test", role: "member" }, scope),
    );
    await service.organizationInvitations.revoke(invocation({}, { ...scope, id: revocable.id }));
    const project = await service.projects.create(invocation({ name: "Platform" }, scope));
    const projectScope = { ...scope, projectId: project.id };
    await service.projects.update(
      invocation({ name: "Platform core" }, { ...projectScope, id: project.id }),
    );
    const environment = await service.environments.create(
      invocation({ name: "Production", type: "production" }, projectScope),
    );
    const environmentScope = { ...projectScope, environmentId: environment.id };
    await service.environments.update(
      invocation({ name: "Primary" }, { ...environmentScope, id: environment.id }),
    );
    // Environment activity is not organization administration.
    await service.workspaces.create(invocation({ name: "Workspace" }, environmentScope));
    await service.environments.archive(invocation({}, { ...environmentScope, id: environment.id }));
    await service.projects.archive(invocation({}, { ...projectScope, id: project.id }));

    const audits = await organizationAudit(store.database, organization.id);
    expect(audits.map((audit) => audit.data.action)).toEqual([
      "project.archived",
      "environment.archived",
      "environment.updated",
      "environment.created",
      "project.updated",
      "project.created",
      "organization-invitation.revoked",
      "organization-invitation.created",
      "organization-invitation.accepted",
      "organization-invitation.created",
      "organization-member.removed",
      "organization-member.role-updated",
      "organization-member.added",
      "organization.updated",
      "organization.created",
    ]);
    const semanticEventIds = new Set(
      [...store.records.values()].flatMap((record) =>
        record.itemType === "semantic-event" ? [record.data.eventId] : [],
      ),
    );
    for (const audit of audits) {
      expect(audit.data.organizationId).toBe(organization.id);
      expect(audit.data.environmentId).toBeUndefined();
      expect(audit.pk).toBe(key("ORG", organization.id));
      expect(semanticEventIds.has(audit.data.eventId)).toBe(true);
    }
    const acceptedActor: string | undefined = audits.find(
      (audit) => audit.data.action === "organization-invitation.accepted",
    )?.data.actor.id;
    expect(acceptedActor).toBe(INVITEE_ID);
    expect(audits.find((audit) => audit.data.action === "environment.created")?.data).toMatchObject(
      {
        actor: { id: OWNER_ID, type: "principal" },
        projectId: project.id,
        resourceId: environment.id,
        resourceType: "environment",
      },
    );
    // Organization administration never leaks into the environment audit partition.
    expect(
      [...store.records.values()].filter(
        (record) =>
          record.itemType === "audit-event" &&
          record.pk === key("ORG", organization.id, "ENV", environment.id),
      ),
    ).toEqual([]);
  });

  test("does not audit lazy expiry of an invitation whose deadline already passed", async () => {
    const store = makeTenancyTestDatabase();
    let current = new Date("2026-07-25T12:00:00.000Z");
    const service = makeTenancyPersistence({ database: store.database, now: () => current });
    const organization = await service.organizations.create(invocation({ name: "Expiry org" }));
    const scope = { organizationId: organization.id };
    await service.organizationInvitations.create(
      invocation(
        { email: "returning@example.test", expiresAt: "2026-07-26T12:00:00.000Z", role: "member" },
        scope,
      ),
    );
    current = new Date("2026-07-27T12:00:00.000Z");
    await service.organizationInvitations.create(
      invocation({ email: "returning@example.test", role: "member" }, scope),
    );

    expect(
      (await organizationAudit(store.database, organization.id)).map((audit) => audit.data.action),
    ).toEqual([
      "organization-invitation.created",
      "organization-invitation.created",
      "organization.created",
    ]);
  });

  test("lists only the requested organization's events and pages without overlap", async () => {
    const store = makeTenancyTestDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const first = await service.organizations.create(invocation({ name: "First org" }));
    const second = await service.organizations.create(invocation({ name: "Second org" }));
    for (const name of ["One", "Two", "Three"]) {
      await service.projects.create(invocation({ name }, { organizationId: first.id }));
    }

    const firstPage = await listOrganizationAuditEventPage(store.database, {
      limit: 2,
      organizationId: first.id,
    });
    const secondPage = await listOrganizationAuditEventPage(store.database, {
      ...(firstPage.lastEvaluatedKey ? { exclusiveStartKey: firstPage.lastEvaluatedKey } : {}),
      limit: 2,
      organizationId: first.id,
    });
    const ids = [...firstPage.items, ...secondPage.items].map((audit) => audit.data.eventId);
    expect(new Set(ids).size).toBe(4);
    expect(secondPage.lastEvaluatedKey).toBeUndefined();
    expect(
      [...firstPage.items, ...secondPage.items].every(
        (audit) => audit.data.organizationId === first.id,
      ),
    ).toBe(true);
    expect(
      (await organizationAudit(store.database, second.id)).map((audit) => audit.data.action),
    ).toEqual(["organization.created"]);
  });
});
