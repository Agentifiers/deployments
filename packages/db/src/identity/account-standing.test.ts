import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import { federationRecord } from "../identity-federation/record-builders.ts";
import {
  ISSUER,
  ORGANIZATION,
  START,
  existingPrincipal,
  id,
  memberRecord,
  organizationRecord,
} from "../identity-federation/test-support.ts";
import { PersistenceError } from "../persistence-types.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { anonymizedPrincipal, principalEmailReplacement } from "./account-records.ts";
import { makeAccountStandingRepository } from "./account-standing.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";

const ADA = id("01ARZ3NDEKTSV4RRFFQ69G5FD0");
const GRACE = id("01ARZ3NDEKTSV4RRFFQ69G5FD1");
const AT = "2026-10-09T12:00:00.000Z";

async function setup() {
  const fake = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES);
  for (const [principalId, email] of [
    [ADA, "ada@example.com"],
    [GRACE, "grace@example.com"],
  ] as const) {
    await database.transactWrite(
      existingPrincipal(email, principalId).flatMap((record) =>
        record.itemType === "principal"
          ? createWithClaims(record, START)
          : [{ kind: "put" as const, record }],
      ),
    );
  }
  const reads = makeFederationReads(database);
  const principal = async (principalId: typeof ADA) => {
    const found = await reads.principal(principalId);
    if (!found) throw new Error("the principal exists");
    return found;
  };
  let event = 0;
  const signInState = async (principalId: typeof ADA) => {
    const [found, security, fence] = await Promise.all([
      principal(principalId),
      reads.securityState(principalId),
      reads.bffFence(principalId),
    ]);
    if (!security || !fence) throw new Error("the person has sign-in state");
    return {
      at: AT,
      eventId: id(`01ARZ3NDEKTSV4RRFFQ69G5FE${event++}`),
      fence,
      principal: found,
      security,
    };
  };
  const swap = async (principalId: typeof ADA, primaryEmail: string) =>
    principalEmailReplacement({ ...(await signInState(principalId)), primaryEmail });
  return { database, fake, principal, reads, signInState, swap };
}

const outcome = (call: Promise<unknown>) =>
  call.then(
    () => "committed",
    (error: unknown) =>
      isDatabaseWriteConflict(error) ? "conflict" : (error as PersistenceError).code,
  );

describe("primary email replacement", () => {
  test("claims the new address, frees the old one, and ends every session at once", async () => {
    const { database, reads, swap } = await setup();
    const epoch = (await reads.securityState(ADA))?.data.sessionEpoch ?? -1;

    await database.transactWrite(await swap(ADA, "ada@new.example"));

    expect({
      fence: (await reads.bffFence(ADA))?.data.sessionEpoch,
      newOwner: (await reads.principalForEmail("ada@new.example"))?.data.id,
      oldOwner: (await reads.principalForEmail("ada@example.com"))?.data.id,
      status: (await reads.bffFence(ADA))?.data.principalStatus,
    }).toEqual({ fence: epoch + 1, newOwner: ADA, oldOwner: undefined, status: "active" });
  });

  test("two people racing for one address: exactly one wins and the loser keeps their own", async () => {
    const { database, principal, reads, swap } = await setup();
    const ada = await swap(ADA, "shared@example.com");
    const grace = await swap(GRACE, "shared@example.com");

    const results = await Promise.all([
      outcome(database.transactWrite(ada)),
      outcome(database.transactWrite(grace)),
    ]);

    expect(results.toSorted()).toEqual(["committed", "conflict"]);
    const winner = results[0] === "committed" ? ADA : GRACE;
    const loser = winner === ADA ? GRACE : ADA;
    expect({
      loserEmail: (await principal(loser)).data.primaryEmail,
      owner: (await reads.principalForEmail("shared@example.com"))?.data.id,
    }).toEqual({
      loserEmail: loser === ADA ? "ada@example.com" : "grace@example.com",
      owner: winner,
    });
  });

  test("an address another person holds cannot be taken", async () => {
    const { database, swap } = await setup();

    expect(await outcome(database.transactWrite(await swap(ADA, "grace@example.com")))).toBe(
      "conflict",
    );
  });
});

describe("deleted account tombstone", () => {
  test("archives the principal without email or name, fences its sessions, and frees the address", async () => {
    const { database, principal, reads, signInState } = await setup();
    const state = await signInState(ADA);
    const { security } = state;

    await database.transactWrite(anonymizedPrincipal(state));

    const tombstone = (await principal(ADA)).data;
    expect({
      displayName: tombstone.displayName,
      epoch: (await reads.securityState(ADA))?.data.sessionEpoch,
      fence: (await reads.bffFence(ADA))?.data,
      owner: await reads.principalForEmail("ada@example.com"),
      primaryEmail: tombstone.primaryEmail,
      status: tombstone.status,
    }).toEqual({
      displayName: undefined,
      epoch: security.data.sessionEpoch + 1,
      fence: expect.objectContaining({
        principalStatus: "archived",
        sessionEpoch: security.data.sessionEpoch + 1,
      }),
      owner: undefined,
      primaryEmail: undefined,
      status: "archived",
    });
  });
});

describe("account standing", () => {
  async function withOrganization(members: readonly ReturnType<typeof memberRecord>[]) {
    const harness = await setup();
    await harness.database.transactWrite(createWithClaims(organizationRecord(), START));
    for (const member of members) await harness.database.putRecord(member);
    const standing = makeAccountStandingRepository({
      database: harness.database,
      now: () => new Date(AT),
    });
    return { ...harness, standing };
  }

  test("marks the only active owner, and names who manages a federated member", async () => {
    const { database, standing } = await withOrganization([
      memberRecord(ADA, "active", "owner"),
      memberRecord(GRACE, "active", "member"),
    ]);
    await database.transactWrite(
      createWithClaims(
        federationRecord("principal-identity", {
          createdAt: START,
          id: id("01ARZ3NDEKTSV4RRFFQ69G5FD9"),
          issuer: ISSUER,
          organizationId: ORGANIZATION,
          principalId: GRACE,
          subject: "okta|grace",
          updatedAt: START,
          version: 1,
        }),
        START,
      ),
    );

    expect([await standing.ties(ADA), await standing.ties(GRACE)]).toEqual([
      [{ organizationId: ORGANIZATION, organizationName: "Acme", role: "owner", soleOwner: true }],
      [
        {
          managedBy: "identity-provider",
          organizationId: ORGANIZATION,
          organizationName: "Acme",
          role: "member",
          soleOwner: false,
        },
      ],
    ]);
  });

  test("the last owner cannot leave; a co-owned organization lets one owner go, once", async () => {
    const sole = await withOrganization([memberRecord(ADA, "active", "owner")]);
    const refused = await outcome(sole.standing.leave(ADA, ORGANIZATION));

    const shared = await withOrganization([
      memberRecord(ADA, "active", "owner"),
      memberRecord(GRACE, "active", "owner"),
    ]);
    await shared.standing.leave(ADA, ORGANIZATION);
    await shared.standing.leave(ADA, ORGANIZATION);

    expect({
      refused,
      removed: (await shared.reads.member(ORGANIZATION, ADA))?.data.status,
      removedEvents: shared.fake
        .items("events")
        .filter(
          (item) =>
            (item.data as { eventType?: string }).eventType === "organization-member.removed",
        ).length,
      ties: await shared.standing.ties(ADA),
    }).toEqual({ refused: "last_owner_required", removed: "removed", removedEvents: 1, ties: [] });
  });
});
