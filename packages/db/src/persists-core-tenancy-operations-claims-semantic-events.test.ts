import { describe, expect, test } from "bun:test";
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

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const _THIRD_PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAS";
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
  test("persists core tenancy operations with claims and semantic events", async () => {
    const store = makeDatabase();
    let nextSecret = 0;
    const service = makeTenancyPersistence({
      database: store.database,
      generateSecret: (credentialId) => `dpl_${credentialId}_secret_${++nextSecret}`,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    const organization = await service.organizations.create(invocation({ name: "Acme Platform" }));
    const organizationScope = { organizationId: organization.id };
    const listedOrganizations = await service.organizations.list(invocation(undefined));
    const fetchedOrganization = await service.organizations.get(
      invocation(undefined, { ...organizationScope, id: organization.id }),
    );
    const updatedOrganization = await service.organizations.update(
      invocation(
        { name: "Acme Cloud", slug: "acme-cloud" },
        { ...organizationScope, id: organization.id },
      ),
    );
    const project = await service.projects.create(
      invocation({ name: "Control Plane" }, organizationScope),
    );
    const projectScope = { ...organizationScope, projectId: project.id };
    const listedProjects = await service.projects.list(invocation(undefined, organizationScope));
    const fetchedProject = await service.projects.get(
      invocation(undefined, { ...projectScope, id: project.id }),
    );
    const updatedProject = await service.projects.update(
      invocation(
        { name: "Runtime Plane", slug: "runtime-plane" },
        { ...projectScope, id: project.id },
      ),
    );
    const environment = await service.environments.create(
      invocation({ name: "Production", type: "production" }, projectScope),
    );
    const environmentScope = { ...projectScope, environmentId: environment.id };
    const listedEnvironments = await service.environments.list(invocation(undefined, projectScope));
    const fetchedEnvironment = await service.environments.get(
      invocation(undefined, { ...environmentScope, id: environment.id }),
    );
    const updatedEnvironment = await service.environments.update(
      invocation(
        { name: "Primary production", slug: "primary-production" },
        { ...environmentScope, id: environment.id },
      ),
    );
    const account = await service.serviceAccounts.create(
      invocation({ name: "Worker", scopes: ["projects:read", "api-keys:read"] }, environmentScope),
    );
    const listedAccounts = await service.serviceAccounts.list(
      invocation(undefined, environmentScope),
    );
    const fetchedAccount = await service.serviceAccounts.get(
      invocation(undefined, { ...environmentScope, id: account.id }),
    );
    const issued = await service.apiCredentials.create(
      invocation({ name: "Worker key", serviceAccountId: account.id }, environmentScope),
    );
    const listedCredentials = await service.apiCredentials.list(
      invocation(undefined, environmentScope),
    );
    const rotated = await service.apiCredentials.rotate(
      invocation({}, { ...environmentScope, id: issued.id }),
    );
    const revoked = await service.apiCredentials.revoke(
      invocation({}, { ...environmentScope, id: issued.id }),
    );
    const disabledAccount = await service.serviceAccounts.revoke(
      invocation({}, { ...environmentScope, id: account.id }),
    );
    const archivedEnvironment = await service.environments.archive(
      invocation({}, { ...environmentScope, id: environment.id }),
    );
    const archivedProject = await service.projects.archive(
      invocation({}, { ...projectScope, id: project.id }),
    );

    expect(organization).toMatchObject({ slug: "acme-platform", version: 1 });
    expect(listedOrganizations.items).toEqual([organization]);
    expect(fetchedOrganization).toEqual(organization);
    expect(updatedOrganization).toMatchObject({ slug: "acme-cloud", version: 2 });
    expect(project).toMatchObject({ organizationId: organization.id, version: 1 });
    expect(listedProjects.items).toEqual([project]);
    expect(fetchedProject).toEqual(project);
    expect(updatedProject).toMatchObject({ slug: "runtime-plane", version: 2 });
    expect(environment).toMatchObject({
      organizationId: organization.id,
      projectId: project.id,
      type: "production",
    });
    expect(listedEnvironments.items).toEqual([environment]);
    expect(fetchedEnvironment).toEqual(environment);
    expect(updatedEnvironment).toMatchObject({ slug: "primary-production", version: 2 });
    expect(listedAccounts.items).toEqual([account]);
    expect(fetchedAccount).toEqual(account);
    expect(listedCredentials.items[0]).not.toHaveProperty("credentialHash");
    expect(listedCredentials.items[0]).not.toHaveProperty("secret");
    expect(rotated.secret).not.toBe(issued.secret);
    expect(revoked).toMatchObject({ status: "revoked", version: 3 });
    expect(disabledAccount).toMatchObject({ status: "disabled", version: 2 });
    expect(archivedEnvironment).toMatchObject({ status: "archived", version: 3 });
    expect(archivedProject).toMatchObject({ status: "archived", version: 3 });
    expect(
      [...store.records.values()].filter((record) => record.itemType === "unique-claim"),
    ).toHaveLength(6);
    expect(
      [...store.records.values()]
        .filter((record) => record.itemType === "semantic-event")
        .map((record) => record.data.eventType),
    ).toEqual([
      "organization.created",
      "organization-member.added",
      "organization.updated",
      "project.created",
      "project.updated",
      "environment.created",
      "environment.updated",
      "service-account.created",
      "api-credential.created",
      "api-credential.rotated",
      "api-credential.revoked",
      "service-account.revoked",
      "environment.archived",
      "project.archived",
    ]);
  });

  test("bootstraps the complete hierarchy from a tenantless principal membership", async () => {
    const store = makeDatabase();
    let nextSecret = 0;
    const service = makeTenancyPersistence({
      database: store.database,
      generateSecret: (credentialId) => `dpl_${credentialId}_secret_${++nextSecret}`,
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };

    const organization = await service.organizations.create(
      invocation({ name: "Bootstrap" }, { identity }),
    );
    const organizations = await service.organizations.list(invocation(undefined, { identity }));
    const project = await service.projects.create(
      invocation({ name: "Bootstrap project" }, { identity, organizationId: organization.id }),
    );
    const environment = await service.environments.create(
      invocation(
        { name: "Bootstrap production", type: "production" },
        { identity, projectId: project.id },
      ),
    );
    const account = await service.serviceAccounts.create(
      invocation(
        { name: "Bootstrap worker", scopes: ["agents:read"] },
        { environmentId: environment.id, identity },
      ),
    );
    const credential = await service.apiCredentials.create(
      invocation(
        { name: "Bootstrap key", serviceAccountId: account.id },
        { environmentId: environment.id, identity },
      ),
    );

    expect(organizations.items).toEqual([organization]);
    expect(project.organizationId).toBe(organization.id);
    expect(environment.projectId).toBe(project.id);
    expect(credential).toMatchObject({
      environmentId: environment.id,
      secretVisibleOnce: true,
      serviceAccountId: account.id,
    });
  });

  test("lists only a platform administrator's own memberships when no organization is selected", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const administrator = {
      platformRole: "administrator" as const,
      principalId: PRINCIPAL_ID,
      scopes: ["organizations:read"],
    };
    const own = await service.organizations.create(
      invocation({ name: "Own" }, { identity: administrator }),
    );
    await service.organizations.create(
      invocation(
        { name: "Customer" },
        { identity: { principalId: OTHER_PRINCIPAL_ID, scopes: ["organizations:write"] } },
      ),
    );

    const listed = await service.organizations.list(
      invocation(undefined, { identity: administrator }),
    );

    expect(listed.items).toEqual([own]);
  });

  test("isolates hierarchy lookups across organization memberships", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const firstIdentity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const secondIdentity = { principalId: OTHER_PRINCIPAL_ID, scopes: ["platform:*"] };
    const firstOrganization = await service.organizations.create(
      invocation({ name: "First" }, { identity: firstIdentity }),
    );
    const otherMembershipOrganization = await service.organizations.create(
      invocation({ name: "Other membership" }, { identity: firstIdentity }),
    );
    const secondOrganization = await service.organizations.create(
      invocation({ name: "Second" }, { identity: secondIdentity }),
    );
    const firstProject = await service.projects.create(
      invocation(
        { name: "First project" },
        { identity: firstIdentity, organizationId: firstOrganization.id },
      ),
    );
    const secondProject = await service.projects.create(
      invocation(
        { name: "Second project" },
        { identity: secondIdentity, organizationId: secondOrganization.id },
      ),
    );
    const otherMembershipProject = await service.projects.create(
      invocation(
        { name: "Other membership project" },
        { identity: firstIdentity, organizationId: otherMembershipOrganization.id },
      ),
    );

    expect(
      service.projects.get(
        invocation(undefined, {
          id: secondProject.id,
          identity: {
            ...firstIdentity,
            organizationIds: [firstOrganization.id],
            projectIds: [firstProject.id],
          },
          projectId: secondProject.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "organization_scope_violation",
      kind: "forbidden",
    });
    expect(
      service.projects.get(
        invocation(undefined, {
          id: otherMembershipProject.id,
          identity: {
            ...firstIdentity,
            organizationIds: [firstOrganization.id],
          },
          projectId: otherMembershipProject.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "organization_scope_violation",
      kind: "forbidden",
    });
  });

  test("binds same-organization project and environment paths to their scopes", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const identity = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const organization = await service.organizations.create(
      invocation({ name: "Shared" }, { identity }),
    );
    const firstProject = await service.projects.create(
      invocation({ name: "First" }, { identity, organizationId: organization.id }),
    );
    const secondProject = await service.projects.create(
      invocation({ name: "Second" }, { identity, organizationId: organization.id }),
    );
    const firstEnvironment = await service.environments.create(
      invocation(
        { name: "First production", type: "production" },
        { identity, projectId: firstProject.id },
      ),
    );
    const secondEnvironment = await service.environments.create(
      invocation(
        { name: "Second production", type: "production" },
        { identity, projectId: secondProject.id },
      ),
    );

    expect(
      service.projects.archive(
        invocation({}, { id: secondProject.id, identity, projectId: firstProject.id }),
      ),
    ).rejects.toMatchObject({ code: "project_scope_violation", kind: "forbidden" });
    expect(
      service.environments.get(
        invocation(undefined, {
          environmentId: firstEnvironment.id,
          id: secondEnvironment.id,
          identity,
        }),
      ),
    ).rejects.toMatchObject({ code: "environment_scope_violation", kind: "forbidden" });
    expect(
      service.environments.get(
        invocation(undefined, {
          environmentId: secondEnvironment.id,
          id: secondEnvironment.id,
          identity: {
            ...identity,
            organizationIds: [organization.id],
            projectIds: [firstProject.id],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "project_scope_violation", kind: "forbidden" });
    expect(
      service.serviceAccounts.list(
        invocation(undefined, {
          environmentId: secondEnvironment.id,
          identity: {
            ...identity,
            environmentIds: [firstEnvironment.id],
            organizationIds: [organization.id],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "environment_scope_violation", kind: "forbidden" });
    const projectConstrainedIdentity = {
      ...identity,
      organizationIds: [organization.id],
      projectIds: [firstProject.id],
    };
    expect(
      service.projects.list(
        invocation(undefined, {
          identity: projectConstrainedIdentity,
          organizationId: organization.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "project_scope_violation", kind: "forbidden" });
    expect(
      service.projects.create(
        invocation(
          { name: "Unauthorized sibling" },
          {
            identity: projectConstrainedIdentity,
            organizationId: organization.id,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "project_scope_violation", kind: "forbidden" });
    const environmentConstrainedIdentity = {
      ...projectConstrainedIdentity,
      environmentIds: [firstEnvironment.id],
    };
    expect(
      service.environments.list(
        invocation(undefined, {
          identity: environmentConstrainedIdentity,
          projectId: firstProject.id,
        }),
      ),
    ).rejects.toMatchObject({ code: "environment_scope_violation", kind: "forbidden" });
    expect(
      service.environments.create(
        invocation(
          { name: "Unauthorized sibling", type: "production" },
          {
            identity: environmentConstrainedIdentity,
            projectId: firstProject.id,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "environment_scope_violation", kind: "forbidden" });
  });

  test("rejects delegated service-account and credential scope escalation", async () => {
    const store = makeDatabase();
    const service = makeTenancyPersistence({ database: store.database });
    const owner = { principalId: PRINCIPAL_ID, scopes: ["platform:*"] };
    const organization = await service.organizations.create(
      invocation({ name: "Delegation" }, { identity: owner }),
    );
    const project = await service.projects.create(
      invocation({ name: "Delegation" }, { identity: owner, organizationId: organization.id }),
    );
    const environment = await service.environments.create(
      invocation(
        { name: "Delegation", type: "production" },
        { identity: owner, projectId: project.id },
      ),
    );
    const constrained = {
      principalId: PRINCIPAL_ID,
      scopes: ["service-accounts:write", "projects:read"],
    };

    expect(
      service.serviceAccounts.create(
        invocation(
          { name: "Escalated", scopes: ["api-keys:write"] },
          { environmentId: environment.id, identity: constrained },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });

    const account = await service.serviceAccounts.create(
      invocation(
        { name: "Reader", scopes: ["api-keys:read"] },
        { environmentId: environment.id, identity: owner },
      ),
    );
    expect(
      service.apiCredentials.create(
        invocation(
          {
            name: "Escalated key",
            scopes: ["api-keys:write"],
            serviceAccountId: account.id,
          },
          { environmentId: environment.id, identity: owner },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });

    const broadAccount = await service.serviceAccounts.create(
      invocation(
        { name: "Broad reader", scopes: ["api-keys:read"] },
        { environmentId: environment.id, identity: owner },
      ),
    );
    const constrainedCredentialIssuer = {
      principalId: PRINCIPAL_ID,
      scopes: ["api-keys:write"],
    };
    expect(
      service.apiCredentials.create(
        invocation(
          { name: "Inherited escalation", serviceAccountId: broadAccount.id },
          { environmentId: environment.id, identity: constrainedCredentialIssuer },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });
    const broadCredential = await service.apiCredentials.create(
      invocation(
        { name: "Broad credential", serviceAccountId: broadAccount.id },
        { environmentId: environment.id, identity: owner },
      ),
    );
    expect(
      service.apiCredentials.rotate(
        invocation(
          {},
          {
            environmentId: environment.id,
            id: broadCredential.id,
            identity: constrainedCredentialIssuer,
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });
  });
});
