import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";
import {
  DatabaseError,
  makeTenancyPersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type PersistenceInvocation,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
} from "./index.ts";
import { humanPrincipalRecord } from "./tenancy-test-support.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const THIRD_PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAS";
let invocationSequence = 0;

function storageKey(table: TableName, key: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}

function conflict() {
  return new DatabaseError({
    cause: new Error("simulated conditional conflict"),
    message: "Conditional write failed.",
    operation: "transact-write",
    reason: "conflict",
    table: "control",
  });
}

function makeDatabase() {
  const records = new Map<string, PlatformRecord>();
  const tableFor = (record: PlatformRecord) => tableForItemType(record.itemType);
  const lookup = (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
    records.get(storageKey(table, key));
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableFor(record), record), structuredClone(record));

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableFor(record), record));
    },
    getRecord: async (table, key) => {
      const record = lookup(table, key);
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const partitionName = names?.["#partition"] ?? "pk";
      const sortName = names?.["#sort"] ?? "sk";
      const partition = values[":partition"] ?? values[":pk"];
      const prefix = String(values[":prefix"]);
      const matching = [...records.values()]
        .filter((record) => tableFor(record) === table)
        .filter(
          (record) =>
            (record as unknown as Record<string, unknown>)[partitionName] === partition &&
            String((record as unknown as Record<string, unknown>)[sortName]).startsWith(prefix),
        )
        .toSorted((left, right) =>
          String((left as unknown as Record<string, unknown>)[sortName]).localeCompare(
            String((right as unknown as Record<string, unknown>)[sortName]),
          ),
        );
      const startKey = input.ExclusiveStartKey as Readonly<Record<string, unknown>> | undefined;
      const start = startKey
        ? matching.findIndex(
            (record) =>
              record.pk === startKey.pk &&
              record.sk === startKey.sk &&
              (record as unknown as Record<string, unknown>)[partitionName] ===
                startKey[partitionName] &&
              (record as unknown as Record<string, unknown>)[sortName] === startKey[sortName],
          ) + 1
        : 0;
      const limit = input.Limit ?? 50;
      const items = matching.slice(start, start + limit);
      const last = items.at(-1);
      const lastEvaluatedKey = last
        ? {
            ...(input.IndexName
              ? {
                  [partitionName]: (last as unknown as Record<string, unknown>)[partitionName],
                  [sortName]: (last as unknown as Record<string, unknown>)[sortName],
                }
              : {}),
            pk: last.pk,
            sk: last.sk,
          }
        : undefined;
      return {
        items: items.map((record) => structuredClone(record)),
        ...(lastEvaluatedKey && start + items.length < matching.length ? { lastEvaluatedKey } : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const existing = lookup(tableFor(operation.record), operation.record);
        if (operation.kind === "put") {
          if (operation.previousRecord) {
            if (
              !existing ||
              (existing.data as { readonly version?: number }).version !==
                (operation.previousRecord.data as { readonly version?: number }).version
            ) {
              throw conflict();
            }
          } else if (!operation.allowExisting && existing) {
            throw conflict();
          }
        } else if (!existing && !operation.allowMissing) {
          throw conflict();
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey(tableFor(operation.record), operation.record));
        } else {
          put(operation.record);
        }
      }
    },
  };
  return { database, records };
}

function invocation<Body>(
  body: Body,
  options: {
    readonly environmentId?: string;
    readonly id?: string;
    readonly identity?: PersistenceInvocation["identity"];
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly query?: PersistenceInvocation["query"];
  } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity: options.identity ?? {
      principalId: PRINCIPAL_ID,
      scopes: ["platform:*"],
      ...(options.organizationId ? { organizationIds: [options.organizationId] } : {}),
      ...(options.projectId ? { projectIds: [options.projectId] } : {}),
      ...(options.environmentId ? { environmentIds: [options.environmentId] } : {}),
    },
    idempotencyKey: `tenancy-service-test-${++invocationSequence}`,
    ...(options.id ? { id: options.id } : {}),
    query: options.query ?? {},
    scope: {
      ...(options.environmentId ? { environmentId: options.environmentId } : {}),
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
  };
}

describe("tenancy persistence", () => {
  test("rejects new children under archived projects and environments", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const organization = await service.organizations.create(
      invocation({ name: "Archival" }, { identity }),
    );
    const project = await service.projects.create(
      invocation({ name: "Archival" }, { identity, organizationId: organization.id }),
    );
    const environment = await service.environments.create(
      invocation({ name: "Archival", type: "production" }, { identity, projectId: project.id }),
    );
    const account = await service.serviceAccounts.create(
      invocation(
        { name: "Existing", scopes: ["api-keys:read"] },
        { environmentId: environment.id, identity },
      ),
    );
    const credential = await service.apiCredentials.create(
      invocation(
        { name: "Existing", serviceAccountId: account.id },
        { environmentId: environment.id, identity },
      ),
    );

    await service.projects.archive(
      invocation({}, { id: project.id, identity, projectId: project.id }),
    );
    expect(
      service.environments.create(
        invocation({ name: "Too late", type: "production" }, { identity, projectId: project.id }),
      ),
    ).rejects.toMatchObject({ code: "project_archived", kind: "conflict" });

    await service.environments.archive(
      invocation({}, { environmentId: environment.id, id: environment.id, identity }),
    );
    expect(
      service.serviceAccounts.create(
        invocation(
          { name: "Too late", scopes: ["api-keys:read"] },
          { environmentId: environment.id, identity },
        ),
      ),
    ).rejects.toMatchObject({ code: "environment_archived", kind: "conflict" });
    expect(
      service.apiCredentials.create(
        invocation(
          { name: "Too late", serviceAccountId: account.id },
          { environmentId: environment.id, identity },
        ),
      ),
    ).rejects.toMatchObject({ code: "environment_archived", kind: "conflict" });
    expect(
      service.apiCredentials.rotate(
        invocation({}, { environmentId: environment.id, id: credential.id, identity }),
      ),
    ).rejects.toMatchObject({ code: "environment_archived", kind: "conflict" });

    const organizationRecord = [...store.records.values()].find(
      (record) => record.itemType === "organization" && record.data.id === organization.id,
    );
    if (!organizationRecord || organizationRecord.itemType !== "organization") {
      throw new Error("Expected the organization record.");
    }
    store.records.set(storageKey("control", organizationRecord), {
      ...organizationRecord,
      data: { ...organizationRecord.data, status: "archived" },
    });
    expect(
      service.projects.create(
        invocation({ name: "Too late" }, { identity, organizationId: organization.id }),
      ),
    ).rejects.toMatchObject({ code: "organization_inactive", kind: "conflict" });
  });

  test("rotates credential hash claims without persisting plaintext secrets", async () => {
    const store = makeDatabase();
    let nextSecret = 0;
    const service = makeTenancyPersistence({
      database: store.database,
      generateSecret: (credentialId) => `dpl_${credentialId}_secret_${++nextSecret}`,
    });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const organization = await service.organizations.create(
      invocation({ name: "Credentials" }, { identity }),
    );
    const project = await service.projects.create(
      invocation({ name: "Credentials" }, { identity, organizationId: organization.id }),
    );
    const environment = await service.environments.create(
      invocation({ name: "Credentials", type: "production" }, { identity, projectId: project.id }),
    );
    const account = await service.serviceAccounts.create(
      invocation(
        { name: "Credentials", scopes: ["api-keys:read"] },
        { environmentId: environment.id, identity },
      ),
    );
    const issued = await service.apiCredentials.create(
      invocation(
        { name: "Credentials", serviceAccountId: account.id },
        { environmentId: environment.id, identity },
      ),
    );
    const firstHash = createHash("sha256").update(issued.secret).digest("hex");
    const rotated = await service.apiCredentials.rotate(
      invocation({}, { environmentId: environment.id, id: issued.id, identity }),
    );
    const rotatedHash = createHash("sha256").update(rotated.secret).digest("hex");
    const serialized = JSON.stringify([...store.records.values()]);

    expect(serialized).not.toContain(issued.secret);
    expect(serialized).not.toContain(rotated.secret);
    expect(
      [...store.records.values()].find(
        (record) =>
          record.itemType === "unique-claim" &&
          record.data.namespace === "api-credential-hash" &&
          record.data.value === firstHash,
      ),
    ).toBeUndefined();
    expect(
      [...store.records.values()].find(
        (record) =>
          record.itemType === "unique-claim" &&
          record.data.namespace === "api-credential-hash" &&
          record.data.value === rotatedHash,
      ),
    ).toBeDefined();
  });

  test("paginates deterministic listings and rejects malformed or cross-scope cursors", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const firstOrganization = await service.organizations.create(
      invocation({ name: "First pagination" }, { identity }),
    );
    const secondOrganization = await service.organizations.create(
      invocation({ name: "Second pagination" }, { identity }),
    );
    await service.projects.create(
      invocation({ name: "First project" }, { identity, organizationId: firstOrganization.id }),
    );
    await service.projects.create(
      invocation({ name: "Second project" }, { identity, organizationId: firstOrganization.id }),
    );

    const firstPage = await service.projects.list(
      invocation(undefined, {
        identity,
        organizationId: firstOrganization.id,
        query: { limit: 1 },
      }),
    );
    const secondPage = await service.projects.list(
      invocation(undefined, {
        identity,
        organizationId: firstOrganization.id,
        query: { cursor: firstPage.nextCursor!, limit: 1 },
      }),
    );

    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
    const tamperedEnvelope = JSON.parse(
      Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"),
    ) as { key: { pk: string } };
    tamperedEnvelope.key.pk = `ORG#${secondOrganization.id}`;
    const tamperedCursor = Buffer.from(JSON.stringify(tamperedEnvelope)).toString("base64url");
    expect(
      service.projects.list(
        invocation(undefined, {
          identity,
          organizationId: firstOrganization.id,
          query: { cursor: tamperedCursor, limit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
    expect(
      service.projects.list(
        invocation(undefined, {
          identity,
          organizationId: secondOrganization.id,
          query: { cursor: firstPage.nextCursor!, limit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
    expect(
      service.projects.list(
        invocation(undefined, {
          identity,
          organizationId: firstOrganization.id,
          query: { cursor: "malformed", limit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });

  test("manages environment-scoped workspaces without leaking across environments", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({
      database: store.database,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const organization = await service.organizations.create(
      invocation({ name: "Workspace org" }, { identity }),
    );
    const project = await service.projects.create(
      invocation({ name: "Workspace project" }, { identity, organizationId: organization.id }),
    );
    const firstEnvironment = await service.environments.create(
      invocation(
        { name: "First environment", type: "production" },
        { identity, projectId: project.id },
      ),
    );
    const secondEnvironment = await service.environments.create(
      invocation(
        { name: "Second environment", type: "staging" },
        { identity, projectId: project.id },
      ),
    );
    const firstScope = { environmentId: firstEnvironment.id, identity };
    const workspace = await service.workspaces.create(
      invocation({ description: "Primary runtime scope", name: "Primary workspace" }, firstScope),
    );
    const listed = await service.workspaces.list(invocation(undefined, firstScope));
    const updated = await service.workspaces.update(
      invocation(
        { description: null, name: "Renamed workspace" },
        { ...firstScope, id: workspace.id },
      ),
    );
    const archived = await service.workspaces.archive(
      invocation({}, { ...firstScope, id: workspace.id }),
    );

    expect(listed.items).toEqual([workspace]);
    expect(updated).toMatchObject({
      name: "Renamed workspace",
      slug: "primary-workspace",
      version: 2,
    });
    expect(updated).not.toHaveProperty("description");
    expect(archived).toMatchObject({ status: "archived", version: 3 });
    expect(
      service.workspaces.get(
        invocation(undefined, {
          environmentId: secondEnvironment.id,
          id: workspace.id,
          identity,
        }),
      ),
    ).rejects.toMatchObject({ code: "resource_not_found", kind: "not-found" });
  });

  test("enforces stored organization roles and token-backed invitation acceptance", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({
      database: store.database,
      generateInvitationToken: (invitationId) => `invite-${invitationId}-secret`,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const ownerIdentity = { principalId: PRINCIPAL_ID, scopes: ["organizations:write"] };
    const organization = await service.organizations.create(
      invocation({ name: "RBAC org" }, { identity: ownerIdentity }),
    );
    const principal = humanPrincipalRecord(OTHER_PRINCIPAL_ID, "viewer@example.test");
    await store.database.putRecord(principal);
    const invitedPrincipal = humanPrincipalRecord(THIRD_PRINCIPAL_ID, "new-user@example.test");
    await store.database.putRecord(invitedPrincipal);
    const organizationScope = {
      identity: ownerIdentity,
      organizationId: organization.id,
    };
    const viewer = await service.organizationMembers.add(
      invocation({ principalId: OTHER_PRINCIPAL_ID, role: "viewer" }, organizationScope),
    );
    const viewerIdentity = {
      organizationIds: [organization.id],
      principalId: OTHER_PRINCIPAL_ID,
      scopes: ["invitations:write"],
    };
    expect(
      service.organizationInvitations.create(
        invocation(
          { email: "blocked@example.test", role: "member" },
          { identity: viewerIdentity, organizationId: organization.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    expect(
      service.authorize(
        invocation(
          { email: "blocked@example.test", role: "member" },
          { identity: viewerIdentity, organizationId: organization.id },
        ),
        "createOrganizationInvitation",
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    expect(
      service.authorize(
        invocation({}, { identity: viewerIdentity, organizationId: organization.id }),
        "discoverMcpServer",
        true,
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    expect(
      service.authorize(
        invocation(
          { name: "Blocked project" },
          { identity: viewerIdentity, organizationId: organization.id },
        ),
        "createProject",
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    expect(
      service.authorize(
        invocation(
          { name: "Owner project" },
          { identity: ownerIdentity, organizationId: organization.id },
        ),
        "createProject",
      ),
    ).resolves.toBeUndefined();
    expect(
      service.authorize(
        invocation(
          { name: "Automated project" },
          {
            identity: {
              authentication: "api-credential",
              organizationIds: [organization.id],
              principalId: OTHER_PRINCIPAL_ID,
              scopes: ["projects:write"],
            },
            organizationId: organization.id,
          },
        ),
        "createProject",
      ),
    ).resolves.toBeUndefined();

    const invitation = await service.organizationInvitations.create(
      invocation({ email: "new-user@example.test", role: "member" }, organizationScope),
    );
    expect(invitation).toMatchObject({
      email: "new-user@example.test",
      secretVisibleOnce: true,
      status: "pending",
    });
    expect(
      service.organizationInvitations.accept(
        invocation(
          { token: invitation.token },
          { id: invitation.id, identity: { principalId: OTHER_PRINCIPAL_ID, scopes: [] } },
        ),
      ),
    ).rejects.toMatchObject({ code: "invitation_email_mismatch", kind: "forbidden" });
    const accepted = await service.organizationInvitations.accept(
      invocation(
        { token: invitation.token },
        {
          id: invitation.id,
          identity: {
            principalId: THIRD_PRINCIPAL_ID,
            scopes: ["invitations:accept"],
          },
        },
      ),
    );
    expect(accepted).toMatchObject({
      organizationId: organization.id,
      principalId: THIRD_PRINCIPAL_ID,
      role: "member",
      status: "active",
    });
    const memberIdentity = {
      organizationIds: [organization.id],
      principalId: THIRD_PRINCIPAL_ID,
      scopes: ["projects:write"],
    };
    expect(
      service.authorize(
        invocation(
          { name: "Blocked member project" },
          { identity: memberIdentity, organizationId: organization.id },
        ),
        "createProject",
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    const promoted = await service.organizationMembers.update(
      invocation({ role: "admin" }, { ...organizationScope, id: THIRD_PRINCIPAL_ID }),
    );
    expect(
      service.authorize(
        invocation(
          { name: "Admin project" },
          { identity: memberIdentity, organizationId: organization.id },
        ),
        "createProject",
      ),
    ).resolves.toBeUndefined();
    const renamedOrganization = await service.organizations.update(
      invocation({ name: "RBAC org renamed" }, { ...organizationScope, id: organization.id }),
    );
    expect(promoted).toMatchObject({ role: "admin", version: 2 });
    expect(renamedOrganization).toMatchObject({ name: "RBAC org renamed", version: 3 });
    const semanticEvents = [...store.records.values()].filter(
      (record) => record.itemType === "semantic-event",
    );
    expect(
      semanticEvents
        .filter(
          (record) =>
            record.data.aggregateType === "organization-member" &&
            record.data.aggregateId === THIRD_PRINCIPAL_ID,
        )
        .map((record) => record.data.aggregateVersion)
        .toSorted((left, right) => left - right),
    ).toEqual([1, 2]);
    expect(
      semanticEvents
        .filter(
          (record) =>
            record.data.aggregateType === "organization" &&
            record.data.aggregateId === organization.id,
        )
        .map((record) => record.data.aggregateVersion)
        .toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    expect(viewer).toMatchObject({ role: "viewer", status: "active" });
    expect(
      service.organizationMembers.update(
        invocation({ role: "admin" }, { ...organizationScope, id: PRINCIPAL_ID }),
      ),
    ).rejects.toMatchObject({ code: "last_owner_required", kind: "conflict" });
    const invitations = await service.organizationInvitations.list(
      invocation(undefined, organizationScope),
    );
    expect(invitations.items).toEqual([]);
  });

  test("reserves global managed-skill catalog mutation for platform administrators", async () => {
    const service = makeTenancyPersistence({ database: makeDatabase().database });
    expect(
      service.authorize(
        invocation(
          { name: "Catalog source" },
          {
            identity: {
              principalId: PRINCIPAL_ID,
              scopes: ["managed-skills:admin"],
            },
          },
        ),
        "createManagedSkillSource",
      ),
    ).rejects.toMatchObject({ code: "insufficient_role", kind: "forbidden" });
    expect(
      service.authorize(
        invocation(
          { name: "Catalog source" },
          {
            identity: {
              platformRole: "administrator",
              principalId: PRINCIPAL_ID,
              scopes: ["managed-skills:admin"],
            },
          },
        ),
        "createManagedSkillSource",
      ),
    ).resolves.toBeUndefined();
  });

  test("releases expired invitation email claims before issuing a replacement", async () => {
    const store = makeDatabase();
    let current = new Date("2026-07-25T12:00:00.000Z");
    const service = makeTenancyPersistence({
      database: store.database,
      now: () => current,
    });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["organizations:write"] };
    const organization = await service.organizations.create(
      invocation({ name: "Invitation expiry org" }, { identity }),
    );
    const organizationScope = {
      identity,
      organizationId: organization.id,
    };
    const first = await service.organizationInvitations.create(
      invocation(
        {
          email: "returning-user@example.test",
          expiresAt: "2026-07-26T12:00:00.000Z",
          role: "member",
        },
        organizationScope,
      ),
    );

    current = new Date("2026-07-27T12:00:00.000Z");
    expect(
      (await service.organizationInvitations.list(invocation(undefined, organizationScope))).items,
    ).toEqual([]);
    const replacement = await service.organizationInvitations.create(
      invocation({ email: "returning-user@example.test", role: "member" }, organizationScope),
    );

    expect(replacement).toMatchObject({
      email: first.email,
      status: "pending",
    });
    expect(replacement.id).not.toBe(first.id);
  });
});
