import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "./dynamo-database.ts";
import type { OidcIdentityProviderSettings } from "./identity-federation/administration-provider.ts";
import { makeIdentityFederationAdministration } from "./identity-federation/administration.ts";
import { beginBrainSearchPlacementMigration } from "./brains/search-placement-repository.ts";
import { BrainSearchPlacementRecord, type BrainSearchTarget } from "./records/brain-search.ts";
import { tableForItemType, withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { DatabaseError, type DynamoDatabaseService } from "./client-types.ts";
import { Ulid } from "./ids.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";
import { makeSemanticEventRecord } from "./semantic-event-storage.ts";
import { makeTenancyPersistence } from "./tenancy-persistence-composition.ts";
import { humanPrincipalRecord } from "./tenancy-test-support.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "./unique-claims.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MEMBER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAT";
const EVENT_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB9");
const NOW = new Date("2026-10-08T12:00:00.000Z");

const oidcSettings = (displayName: string): OidcIdentityProviderSettings => ({
  clientId: "client-1",
  discovered: {
    endpoints: {
      authorization: "https://idp.example.com/authorize",
      jwks: "https://idp.example.com/keys",
      token: "https://idp.example.com/token",
    },
    signingAlgorithms: ["RS256"],
    tokenEndpointAuthMethod: "client_secret_basic",
  },
  displayName,
  issuer: "https://idp.example.com",
  jit: { kind: "enabled", role: "member" },
  protocol: "oidc",
  sealClientSecret: async () => ({
    algorithm: "AES-256-GCM",
    authenticationTag: "tag",
    ciphertext: "ciphertext",
    encryptedDataKey: "data-key",
    encryptionContextHash: "context-hash",
    iv: "iv",
    schemaVersion: 1,
  }),
});

const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "committed",
    (cause: unknown) => (cause instanceof DatabaseError ? cause.reason : "unexpected"),
  );
let sequence = 0;

function invocation<Body>(
  body: Body,
  scope: PersistenceInvocation["scope"] = {},
  id?: string,
): PersistenceInvocation<Body> {
  return {
    body,
    identity: { principalId: PRINCIPAL_ID, scopes: ["platform:*"] },
    idempotencyKey: `expired-events-${++sequence}`,
    ...(id ? { id } : {}),
    query: {},
    scope,
  };
}

async function issuedCredential() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const principal of [
    humanPrincipalRecord(PRINCIPAL_ID, "owner@acme.example"),
    humanPrincipalRecord(MEMBER_ID, "member@acme.example"),
  ]) {
    fake.put(tables.control, principal);
    for (const requirement of uniqueClaimRequirements(principal)) {
      fake.put(tables.control, makeUniqueClaimRecord(requirement, principal.data.createdAt));
    }
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const organization = await tenancy.organizations.create(invocation({ name: "Acme" }));
  const project = await tenancy.projects.create(
    invocation({ name: "Runtime" }, { organizationId: organization.id }),
  );
  const projectScope = { organizationId: organization.id, projectId: project.id };
  const environment = await tenancy.environments.create(
    invocation({ name: "Production", type: "production" }, projectScope),
  );
  const scope = { ...projectScope, environmentId: environment.id };
  const account = await tenancy.serviceAccounts.create(
    invocation({ name: "Messaging", scopes: ["projects:read"] }, scope),
  );
  const credential = await tenancy.apiCredentials.create(
    invocation({ name: "Messaging key", serviceAccountId: account.id }, scope),
  );
  const aggregateEvents = (aggregateType: string, aggregateId: string) =>
    fake
      .items(tables.events)
      .filter(
        (item) => item.pk === `ORG#${organization.id}#AGGREGATE#${aggregateType}#${aggregateId}`,
      );
  const expireEvents = (aggregateType: string, aggregateId: string) => {
    for (const item of aggregateEvents(aggregateType, aggregateId)) {
      fake.delete(tables.events, { pk: String(item.pk), sk: String(item.sk) });
    }
  };
  return {
    account,
    aggregateEvents,
    credential,
    database,
    expireEvents,
    organizationId: ulid(organization.id),
    scope,
    seed: (record: PlatformRecord) => fake.put(tableForItemType(record.itemType), record),
    tenancy,
  };
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof PersistenceError) return { code: cause.code, kind: cause.kind };
    throw cause;
  }
  throw new Error("Expected a persistence failure.");
}

describe("aggregates whose semantic events retention deleted", () => {
  test("rotates and revokes the credential and disables its service account", async () => {
    const { account, aggregateEvents, credential, expireEvents, scope, tenancy } =
      await issuedCredential();
    expireEvents("api-credential", credential.id);
    expireEvents("service-account", account.id);

    const rotated = await tenancy.apiCredentials.rotate(invocation({}, scope, credential.id));
    const revoked = await tenancy.apiCredentials.revoke(invocation({}, scope, credential.id));
    const disabled = await tenancy.serviceAccounts.revoke(invocation({}, scope, account.id));

    expect({ status: rotated.status, version: rotated.version }).toEqual({
      status: "active",
      version: 2,
    });
    expect({ status: revoked.status, version: revoked.version }).toEqual({
      status: "revoked",
      version: 3,
    });
    expect({ status: disabled.status, version: disabled.version }).toEqual({
      status: "disabled",
      version: 2,
    });
    expect(aggregateEvents("api-credential", credential.id).map((item) => item.sk)).toEqual([
      "SEMANTIC-EVENT#0000000000000002",
      "SEMANTIC-EVENT#0000000000000003",
    ]);
    expect(aggregateEvents("service-account", account.id).map((item) => item.sk)).toEqual([
      "SEMANTIC-EVENT#0000000000000002",
    ]);
  });

  for (const chain of ["intact", "expired"] as const) {
    test(`reports a revoke that loses a race with a rotation as version_conflict (${chain} chain)`, async () => {
      const { credential, database, expireEvents, scope, tenancy } = await issuedCredential();
      if (chain === "expired") expireEvents("api-credential", credential.id);
      let raced = false;
      const racing: DynamoDatabaseService = {
        ...database,
        transactWrite: async (...args) => {
          if (!raced) {
            raced = true;
            await tenancy.apiCredentials.rotate(invocation({}, scope, credential.id));
          }
          return database.transactWrite(...args);
        },
      };

      const lost = await failure(
        makeTenancyPersistence({ database: racing }).apiCredentials.revoke(
          invocation({}, scope, credential.id),
        ),
      );
      const stored = (await tenancy.apiCredentials.list(invocation(undefined, scope))).items.find(
        (item) => item.id === credential.id,
      );

      expect(lost).toEqual({ code: "version_conflict", kind: "conflict" });
      expect({ status: stored?.status, version: stored?.version }).toEqual({
        status: "active",
        version: 2,
      });
    });
  }

  test("orders an event by its aggregate record's versioned write, else by its predecessor event", async () => {
    const { credential, database, expireEvents, scope } = await issuedCredential();
    expireEvents("api-credential", credential.id);
    const stored = await database.getRecord("control", {
      pk: `ORG#${scope.organizationId}#ENV#${scope.environmentId}`,
      sk: `API-CREDENTIAL#${credential.id}`,
    });
    if (stored?.itemType !== "api-credential") throw new Error("Expected the stored credential.");
    const renamed = withCanonicalRecordKeys({
      ...stored,
      data: { ...stored.data, name: "Renamed key", version: 2 },
    });
    const event = (aggregateVersion: number) =>
      makeSemanticEventRecord({
        aggregateId: ulid(credential.id),
        aggregateType: "api-credential",
        aggregateVersion,
        eventId: EVENT_ID,
        eventType: "api-credential.renamed",
        organizationId: ulid(scope.organizationId),
        payload: {},
      });

    const eventAlone = await outcome(database.transactWrite([{ kind: "put", record: event(2) }]));
    const eventWithRecord = await outcome(
      database.transactWrite([
        { kind: "put", previousRecord: stored, record: renamed },
        { kind: "put", record: event(3) },
      ]),
    );

    expect({ eventAlone, eventWithRecord }).toEqual({
      eventAlone: "conflict",
      eventWithRecord: "committed",
    });
  });

  test("updates and removes an organization member", async () => {
    const { expireEvents, organizationId, tenancy } = await issuedCredential();
    await tenancy.organizationMembers.add(
      invocation({ principalId: MEMBER_ID, role: "viewer" }, { organizationId }),
    );
    expireEvents("organization-member", MEMBER_ID);

    const updated = await tenancy.organizationMembers.update(
      invocation({ role: "admin" }, { organizationId }, MEMBER_ID),
    );
    const removed = await tenancy.organizationMembers.remove(
      invocation({}, { organizationId }, MEMBER_ID),
    );

    expect(
      [updated, removed].map(({ role, status, version }) => ({ role, status, version })),
    ).toEqual([
      { role: "admin", status: "active", version: 2 },
      { role: "admin", status: "removed", version: 3 },
    ]);
  });

  test("updates and deletes an organization identity provider", async () => {
    const { aggregateEvents, database, expireEvents, organizationId } = await issuedCredential();
    const administration = makeIdentityFederationAdministration({ database, now: () => NOW });
    const administrator = { organizationId, principalId: ulid(PRINCIPAL_ID) };
    await administration.putIdentityProvider(administrator, oidcSettings("Acme Okta"));
    expireEvents("organization-identity-provider", organizationId);

    const renamed = await administration.putIdentityProvider(
      administrator,
      oidcSettings("Acme SSO"),
    );
    const deleted = await administration.deleteIdentityProvider(administrator);

    expect({ displayName: renamed.data.displayName, version: deleted.data.version }).toEqual({
      displayName: "Acme SSO",
      version: 2,
    });
    expect(
      aggregateEvents("organization-identity-provider", organizationId).map((item) => item.sk),
    ).toEqual(["SEMANTIC-EVENT#0000000000000002", "SEMANTIC-EVENT#0000000000000003"]);
  });

  for (const chain of ["intact", "expired"] as const) {
    test(`does not let another record sharing the aggregate id order its event (${chain} chain)`, async () => {
      const { database, expireEvents, organizationId, tenancy } = await issuedCredential();
      const member = await tenancy.organizationMembers.add(
        invocation({ principalId: MEMBER_ID, role: "viewer" }, { organizationId }),
      );
      if (chain === "expired") expireEvents("organization-member", MEMBER_ID);
      const principal = humanPrincipalRecord(MEMBER_ID, "member@acme.example");

      const appended = await outcome(
        database.transactWrite([
          {
            kind: "put",
            previousRecord: principal,
            record: withCanonicalRecordKeys({
              ...principal,
              data: { ...principal.data, version: 2 },
            }),
          },
          {
            kind: "put",
            record: makeSemanticEventRecord({
              aggregateId: ulid(MEMBER_ID),
              aggregateType: "organization-member",
              aggregateVersion: member.version + 1,
              eventId: EVENT_ID,
              eventType: "organization-member.role-updated",
              organizationId,
              payload: {},
            }),
          },
        ]),
      );

      expect(appended).toBe(chain === "intact" ? "committed" : "conflict");
    });
  }

  test("begins a Brain search migration on a placement whose activation event retention deleted", async () => {
    const { aggregateEvents, database, organizationId, seed } = await issuedCredential();
    const target = (targetId: string): BrainSearchTarget => ({
      components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
        componentId: ulid(`01ARZ3NDEKTSV4RRFFQ69G5FC${index}`),
        kind,
      })),
      embeddingProfileId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FC5"),
      location: { openSearchIndex: `brain-${targetId}` },
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: ulid(targetId),
    });
    const serving = target("01ARZ3NDEKTSV4RRFFQ69G5FC6");
    seed(
      Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: NOW.toISOString(),
            generation: 1,
            organizationId,
            phase: "active" as const,
            readTarget: serving,
            updatedAt: NOW.toISOString(),
            version: 1,
            writeTarget: serving,
          },
          itemType: "brain-search-placement" as const,
        }),
      ),
    );

    const migrating = await beginBrainSearchPlacementMigration({
      actorPrincipalId: PRINCIPAL_ID,
      database,
      eventId: EVENT_ID,
      now: NOW.toISOString(),
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FC7",
      organizationId,
      target: target("01ARZ3NDEKTSV4RRFFQ69G5FC8"),
    });

    expect({ generation: migrating.data.generation, version: migrating.data.version }).toEqual({
      generation: 2,
      version: 2,
    });
    expect(
      aggregateEvents("brain-search-placement", organizationId).map((item) => item.sk),
    ).toEqual(["SEMANTIC-EVENT#0000000000000002"]);
  });
});
