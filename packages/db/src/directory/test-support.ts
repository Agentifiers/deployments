import { Effect, Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { makeIdentityFederationAdministration } from "../identity-federation/administration.ts";
import { decodePlatformRecord, type PlatformRecord, type TableName } from "../records/index.ts";
import { makeTenancyPersistence } from "../tenancy-persistence-composition.ts";
import { humanPrincipalRecord } from "../tenancy-test-support.ts";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "../testing/dynamo-document-client.fixture.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import type { DirectoryCaller } from "./administration.ts";
import { makeDirectory, type Directory } from "./index.ts";

export const ulid = Schema.decodeUnknownSync(Ulid);
export const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
export const RIVAL = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
export const NOW = new Date("2026-10-08T12:00:00.000Z");

export interface DirectoryHarness {
  readonly acme: Ulid;
  readonly database: DynamoDatabaseService;
  readonly fake: FakeDynamoDocumentClient;
  readonly rival: Ulid;
}

let sequence = 0;

/** A real DynamoDB data layer over the fake client, with two organizations owned by two people. */
export async function directoryHarness(): Promise<DirectoryHarness> {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const owner of [
    humanPrincipalRecord(OWNER, "owner@acme.example"),
    humanPrincipalRecord(RIVAL, "owner@rival.example"),
  ]) {
    fake.put(tables.control, owner);
    for (const claim of uniqueClaimRequirements(owner)) {
      fake.put(tables.control, makeUniqueClaimRecord(claim, owner.data.createdAt));
    }
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const organization = async (principalId: Ulid, name: string) => {
    const created = await tenancy.organizations.create({
      body: { name },
      identity: { principalId, scopes: ["platform:*"] },
      idempotencyKey: `directory-organization-${++sequence}`,
      query: {},
      scope: {},
    });
    return ulid(created.id);
  };
  return {
    acme: await organization(OWNER, "Acme"),
    database,
    fake,
    rival: await organization(RIVAL, "Rival"),
  };
}

/** Every stored record of one item type, decoded. Tables use their logical names in tests. */
export function storedRecords<ItemType extends PlatformRecord["itemType"]>(
  fake: FakeDynamoDocumentClient,
  table: TableName,
  itemType: ItemType,
) {
  return fake
    .items(table)
    .map((item) => Effect.runSync(decodePlatformRecord(item)))
    .filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
        record.itemType === itemType,
    );
}

export interface ProvisioningHarness extends DirectoryHarness {
  readonly acmeCaller: DirectoryCaller;
  readonly directory: Directory;
  readonly rivalCaller: DirectoryCaller;
}

/**
 * Acme verifies acme.example and Rival verifies rival.example; each has a directory whose default
 * role is member and one SCIM token.
 */
export async function provisioningHarness(): Promise<ProvisioningHarness> {
  const harness = await directoryHarness();
  const federation = makeIdentityFederationAdministration({
    database: harness.database,
    now: () => NOW,
  });
  const directory = makeDirectory({ database: harness.database, now: () => NOW });
  const configure = async (organizationId: Ulid, principalId: Ulid, domain: string) => {
    const administrator = { organizationId, principalId };
    const pending = await federation.addLoginDomain(administrator, domain);
    await federation.verifyLoginDomain(administrator, pending.data.id, async () => [
      `deployments-login=${pending.data.verificationToken}`,
    ]);
    await directory.putSettings(administrator, { defaultRole: "member" });
    const issued = await directory.issueToken(administrator);
    const caller = await directory.authenticate(issued.secret);
    if (!caller) throw new Error("A freshly issued directory token did not authenticate.");
    return caller;
  };
  return {
    ...harness,
    acmeCaller: await configure(harness.acme, OWNER, "acme.example"),
    directory,
    rivalCaller: await configure(harness.rival, RIVAL, "rival.example"),
  };
}
