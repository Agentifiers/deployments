import { describe, expect, test } from "bun:test";
import { makeTenancyPersistence, PersistenceError, type PersistenceIdentity } from "./index.ts";
import { makeTenancyTestDatabase } from "./tenancy-test-support.ts";

const OWNER = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AUTOMATION = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
let sequence = 0;

function call<Body>(
  body: Body,
  identity: PersistenceIdentity,
  scope: {
    readonly environmentId?: string;
    readonly organizationId?: string;
    readonly projectId?: string;
  },
  id?: string,
) {
  return {
    body,
    identity,
    idempotencyKey: `delegation-${++sequence}`,
    ...(id ? { id } : {}),
    query: {},
    scope,
  };
}

function outcome(attempt: Promise<{ readonly scopes: readonly string[] }>) {
  return attempt.then(
    (created) => created.scopes,
    (error: unknown) => {
      if (error instanceof PersistenceError) return error.code;
      throw error;
    },
  );
}

async function delegationHarness() {
  const service = makeTenancyPersistence({ database: makeTenancyTestDatabase().database });
  const owner: PersistenceIdentity = { principalId: OWNER, scopes: ["platform:*"] };
  const organization = await service.organizations.create(call({ name: "Delegation" }, owner, {}));
  const project = await service.projects.create(
    call({ name: "Delegation" }, owner, { organizationId: organization.id }),
  );
  const environment = await service.environments.create(
    call({ name: "Delegation", type: "production" }, owner, { projectId: project.id }),
  );
  const scope = { environmentId: environment.id };
  return {
    account: (scopes: readonly string[]) =>
      service.serviceAccounts.create(call({ name: "Publisher", scopes }, owner, scope)),
    createAccount: (identity: PersistenceIdentity, scopes: readonly string[]) =>
      outcome(service.serviceAccounts.create(call({ name: "Minted", scopes }, identity, scope))),
    createKey: (
      identity: PersistenceIdentity,
      serviceAccountId: string,
      scopes?: readonly string[],
    ) =>
      outcome(
        service.apiCredentials.create(
          call(
            { name: "Minted key", serviceAccountId, ...(scopes ? { scopes } : {}) },
            identity,
            scope,
          ),
        ),
      ),
    key: (scopes: readonly string[]): PersistenceIdentity => ({
      authentication: "api-credential",
      environmentIds: [environment.id],
      organizationIds: [organization.id],
      principalId: AUTOMATION,
      projectIds: [project.id],
      scopes,
    }),
    issueKey: (serviceAccountId: string) =>
      service.apiCredentials.create(call({ name: "Publish key", serviceAccountId }, owner, scope)),
    owner,
    rotateKey: (identity: PersistenceIdentity, credentialId: string) =>
      outcome(service.apiCredentials.rotate(call({}, identity, scope, credentialId))),
  };
}

describe("delegating apps:publish", () => {
  test("an API key delegates apps:publish only when it names the scope itself", async () => {
    const { account, createAccount, createKey, issueKey, key, rotateKey } =
      await delegationHarness();
    const publisher = await account(["apps:read", "apps:publish"]);
    const { id: publishKey } = await issueKey(publisher.id);
    const wildcard = key(["apps:*", "api-keys:write", "service-accounts:write"]);
    const platform = key(["platform:*"]);
    const literal = key(["apps:*", "apps:publish", "api-keys:write", "service-accounts:write"]);

    expect({
      "literal key creates an account": await createAccount(literal, ["apps:publish"]),
      "literal key creates a key": await createKey(literal, publisher.id, ["apps:publish"]),
      "literal key rotates a publish key": await rotateKey(literal, publishKey),
      "platform key creates an account": await createAccount(platform, ["apps:publish"]),
      "platform key creates a key": await createKey(platform, publisher.id, ["apps:publish"]),
      "platform key inherits the account's scopes": await createKey(platform, publisher.id),
      "platform key rotates a publish key": await rotateKey(platform, publishKey),
      "wildcard key creates an account": await createAccount(wildcard, ["apps:publish"]),
      "wildcard key creates a key": await createKey(wildcard, publisher.id, ["apps:publish"]),
      "wildcard key rotates a publish key": await rotateKey(wildcard, publishKey),
      "wildcard key still delegates apps:read": await createKey(wildcard, publisher.id, [
        "apps:read",
      ]),
    }).toEqual({
      "literal key creates an account": ["apps:publish"],
      "literal key creates a key": ["apps:publish"],
      "literal key rotates a publish key": ["apps:read", "apps:publish"],
      "platform key creates an account": "invalid_scope",
      "platform key creates a key": "invalid_scope",
      "platform key inherits the account's scopes": "invalid_scope",
      "platform key rotates a publish key": "invalid_scope",
      "wildcard key creates an account": "invalid_scope",
      "wildcard key creates a key": "invalid_scope",
      "wildcard key rotates a publish key": "invalid_scope",
      "wildcard key still delegates apps:read": ["apps:read"],
    });
  });

  test("a person grants apps:publish from a wildcard, but only to an account that names it", async () => {
    const { account, createAccount, createKey, owner } = await delegationHarness();
    const wildcardAccount = await account(["apps:*"]);
    const publisher = await account(["apps:publish"]);

    expect({
      "account naming apps:publish": await createAccount(owner, ["apps:publish"]),
      "key on an account naming apps:publish": await createKey(owner, publisher.id, [
        "apps:publish",
      ]),
      "key on an account holding apps:*": await createKey(owner, wildcardAccount.id, [
        "apps:publish",
      ]),
    }).toEqual({
      "account naming apps:publish": ["apps:publish"],
      "key on an account naming apps:publish": ["apps:publish"],
      "key on an account holding apps:*": "invalid_scope",
    });
  });
});
