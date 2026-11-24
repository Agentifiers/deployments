import { describe, expect, test } from "bun:test";
import { newHumanPrincipalOperations } from "../identity/principal-creation.ts";
import type { Ulid } from "../ids.ts";
import type { DirectoryCaller } from "./administration.ts";
import type { DirectoryResult, DirectoryUser } from "./users.ts";
import {
  OWNER,
  provisioningHarness,
  storedRecords,
  ulid,
  type ProvisioningHarness,
} from "./test-support.ts";

const AT = "2026-10-08T12:00:00.000Z";
const ADA = {
  active: true,
  displayName: "Ada Lovelace",
  email: "ada@acme.example",
  externalId: "00u-ada",
  userName: "ada@acme.example",
};

function created(result: DirectoryResult<DirectoryUser>) {
  if (result.kind !== "ok") throw new Error(`Expected a user, got ${result.reason}.`);
  return result.value;
}

function membershipOf(harness: ProvisioningHarness, organizationId: Ulid, principalId: Ulid) {
  return storedRecords(harness.fake, "control", "organization-member")
    .filter(
      (member) =>
        member.data.organizationId === organizationId && member.data.principalId === principalId,
    )
    .map((member) => [member.data.role, member.data.status]);
}

async function existingPerson(harness: ProvisioningHarness, email: string, principalId: Ulid) {
  await harness.database.transactWrite(
    newHumanPrincipalOperations({
      createdAt: AT,
      displayName: "Existing Person",
      eventId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE9"),
      mailbox: "unverified",
      primaryEmail: email,
      principalId,
    }),
  );
}

describe("directory users", () => {
  test("creating an unknown person provisions the principal and membership in one transaction", async () => {
    const harness = await provisioningHarness();
    const before = harness.fake.transactions.length;

    const user = created(await harness.directory.users.create(harness.acmeCaller, ADA));

    expect(user).toEqual({
      active: true,
      created: AT,
      displayName: "Ada Lovelace",
      email: "ada@acme.example",
      externalId: "00u-ada",
      id: user.id,
      lastModified: AT,
      userName: "ada@acme.example",
    });
    const writes = harness.fake.transactions.slice(before);
    expect(writes.map((write) => write.outcome)).toEqual(["applied"]);
    const items = writes[0]?.input.TransactItems ?? [];
    expect(items.length).toBeLessThan(100);
    expect(
      [
        ...new Set(items.flatMap((item) => (item.Put ? [String(item.Put.Item?.itemType)] : []))),
      ].toSorted(),
    ).toEqual([
      "audit-event",
      "governance-tenant-record",
      "identity-bff-revocation-fence",
      "identity-security-event",
      "organization-directory-user",
      "organization-member",
      "principal",
      "principal-security-state",
      "semantic-event",
      "unique-claim",
    ]);
    expect(
      storedRecords(harness.fake, "identity", "principal-security-state").map((state) => [
        state.data.principalId,
        state.data.emailVerifiedAt,
      ]),
    ).toEqual([[user.id, AT]]);
    expect(membershipOf(harness, harness.acme, user.id)).toEqual([["member", "active"]]);
    expect(
      storedRecords(harness.fake, "control", "organization-directory-user").map(
        (mapping) => mapping.data.origin,
      ),
    ).toEqual(["provisioned"]);
    expect(
      storedRecords(harness.fake, "events", "audit-event")
        .filter((audit) => audit.data.actor.type === "directory-token")
        .map((audit) => [audit.data.action, audit.data.actor.id]),
    ).toEqual([["organization-directory-user.created", harness.acmeCaller.tokenId]]);
  });

  test("an existing person is adopted without changing the principal", async () => {
    const harness = await provisioningHarness();
    const grace = ulid("01ARZ3NDEKTSV4RRFFQ69G5FE0");
    await existingPerson(harness, "grace@acme.example", grace);

    const user = created(
      await harness.directory.users.create(harness.acmeCaller, {
        active: true,
        displayName: "Rear Admiral Hopper",
        email: "grace@acme.example",
        userName: "ghopper",
      }),
    );

    expect([user.id, user.displayName, user.userName, user.email]).toEqual([
      grace,
      "Existing Person",
      "ghopper",
      "grace@acme.example",
    ]);
    expect(membershipOf(harness, harness.acme, grace)).toEqual([["member", "active"]]);
    expect(
      storedRecords(harness.fake, "control", "organization-directory-user").map(
        (mapping) => mapping.data.origin,
      ),
    ).toEqual(["adopted"]);
  });

  test("an email outside the organization's verified domains is refused", async () => {
    const harness = await provisioningHarness();
    expect(
      await harness.directory.users.create(harness.acmeCaller, {
        ...ADA,
        email: "ada@rival.example",
        userName: "ada@rival.example",
      }),
    ).toEqual({ kind: "refused", reason: "email_domain_not_verified" });
  });

  test("the owner can be mapped but never deactivated or deleted", async () => {
    const harness = await provisioningHarness();
    const owner = created(
      await harness.directory.users.create(harness.acmeCaller, {
        active: true,
        email: "owner@acme.example",
        userName: "owner@acme.example",
      }),
    );
    expect(owner.id).toBe(OWNER);

    expect(
      await harness.directory.users.change(harness.acmeCaller, OWNER, { active: false }),
    ).toEqual({ kind: "refused", reason: "protected_role" });
    expect(await harness.directory.users.delete(harness.acmeCaller, OWNER)).toEqual({
      kind: "refused",
      reason: "protected_role",
    });
    expect(membershipOf(harness, harness.acme, OWNER)).toEqual([["owner", "active"]]);
  });

  test("deactivating removes the membership and reactivating restores the default role", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const ada = created(await users.create(harness.acmeCaller, ADA));

    const inactive = created(await users.change(harness.acmeCaller, ada.id, { active: false }));
    expect(inactive.active).toBe(false);
    expect(membershipOf(harness, harness.acme, ada.id)).toEqual([["member", "removed"]]);

    await harness.directory.putSettings(
      { organizationId: harness.acme, principalId: OWNER },
      { defaultRole: "viewer" },
    );
    const active = created(await users.change(harness.acmeCaller, ada.id, { active: true }));
    expect(active.active).toBe(true);
    expect(membershipOf(harness, harness.acme, ada.id)).toEqual([["viewer", "active"]]);
  });

  test("a deactivating PUT with another user's userName and externalId still removes the membership", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const ada = created(await users.create(harness.acmeCaller, ADA));
    await users.create(harness.acmeCaller, {
      active: true,
      email: "grace@acme.example",
      externalId: "00u-grace",
      userName: "grace@acme.example",
    });
    const takenMapping = {
      displayName: "Ada Lovelace",
      externalId: "00u-grace",
      userName: "grace@acme.example",
    };

    expect(
      await users.change(harness.acmeCaller, ada.id, { ...takenMapping, active: true }),
    ).toEqual({ kind: "refused", reason: "user_exists" });
    const inactive = created(
      await users.change(harness.acmeCaller, ada.id, { ...takenMapping, active: false }),
    );

    expect([inactive.active, inactive.userName, inactive.externalId]).toEqual([
      false,
      "ada@acme.example",
      "00u-ada",
    ]);
    expect(membershipOf(harness, harness.acme, ada.id)).toEqual([["member", "removed"]]);
  });

  test("a deleted user is gone and can be provisioned again", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const ada = created(await users.create(harness.acmeCaller, ADA));

    expect(await users.delete(harness.acmeCaller, ada.id)).toEqual({ kind: "ok", value: null });
    expect(await users.get(harness.acmeCaller, ada.id)).toEqual({
      kind: "refused",
      reason: "user_not_found",
    });
    expect(membershipOf(harness, harness.acme, ada.id)).toEqual([["member", "removed"]]);
    expect(
      await users.list(harness.acmeCaller, {
        count: 10,
        filter: { attribute: "userName", value: "ada@acme.example" },
        startIndex: 1,
      }),
    ).toEqual({ items: [], startIndex: 1, totalResults: 0 });

    const again = created(await users.create(harness.acmeCaller, ADA));
    expect([again.id, again.active]).toEqual([ada.id, true]);
  });

  test("renaming keeps the person and moves the lookups", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const ada = created(await users.create(harness.acmeCaller, ADA));

    const renamed = created(
      await users.change(harness.acmeCaller, ada.id, {
        displayName: "Countess of Lovelace",
        externalId: "00u-ada-2",
        userName: "Countess@acme.example",
      }),
    );
    expect([renamed.userName, renamed.externalId, renamed.displayName]).toEqual([
      "Countess@acme.example",
      "00u-ada-2",
      "Countess of Lovelace",
    ]);
    const lookup = (attribute: "externalId" | "userName", value: string) =>
      users
        .list(harness.acmeCaller, { count: 10, filter: { attribute, value }, startIndex: 1 })
        .then((page) => page.items.map((item) => item.id));
    expect(
      await Promise.all([
        lookup("userName", "countess@ACME.example"),
        lookup("userName", "ada@acme.example"),
        lookup("externalId", "00u-ada-2"),
        lookup("externalId", "00u-ada"),
      ]),
    ).toEqual([[ada.id], [], [ada.id], []]);
  });

  test("lists users in pages with the total count", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    for (const name of ["ada", "grace", "hedy"]) {
      created(
        await users.create(harness.acmeCaller, {
          active: true,
          email: `${name}@acme.example`,
          userName: `${name}@acme.example`,
        }),
      );
    }
    const page = await users.list(harness.acmeCaller, { count: 2, startIndex: 2 });
    expect([page.startIndex, page.totalResults, page.items.length]).toEqual([2, 3, 2]);
    expect((await users.list(harness.acmeCaller, { count: 0, startIndex: 1 })).totalResults).toBe(
      3,
    );
  });

  test("concurrent creates with one userName or externalId leave one user", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const outcome = (result: DirectoryResult<DirectoryUser>) =>
      result.kind === "ok" ? "created" : result.reason;

    const sameUserName = await Promise.all([
      users.create(harness.acmeCaller, { ...ADA, externalId: "00u-1" }).then(outcome),
      users
        .create(harness.acmeCaller, { ...ADA, email: "lovelace@acme.example", externalId: "00u-2" })
        .then(outcome),
    ]);
    expect(sameUserName.toSorted()).toEqual(["created", "user_exists"]);

    const sameExternalId = await Promise.all([
      users
        .create(harness.acmeCaller, {
          active: true,
          email: "grace@acme.example",
          externalId: "00u-shared",
          userName: "grace@acme.example",
        })
        .then(outcome),
      users
        .create(harness.acmeCaller, {
          active: true,
          email: "hedy@acme.example",
          externalId: "00u-shared",
          userName: "hedy@acme.example",
        })
        .then(outcome),
    ]);
    expect(sameExternalId.toSorted()).toEqual(["created", "external_id_taken"]);
    expect(storedRecords(harness.fake, "control", "organization-directory-user")).toHaveLength(2);
  });

  test("one organization's token cannot see or change another organization's users", async () => {
    const harness = await provisioningHarness();
    const { users } = harness.directory;
    const ada = created(await users.create(harness.acmeCaller, ADA));
    const rival: DirectoryCaller = harness.rivalCaller;

    expect(await users.get(rival, ada.id)).toEqual({ kind: "refused", reason: "user_not_found" });
    expect(await users.change(rival, ada.id, { active: false })).toEqual({
      kind: "refused",
      reason: "user_not_found",
    });
    expect(await users.delete(rival, ada.id)).toEqual({
      kind: "refused",
      reason: "user_not_found",
    });
    expect((await users.list(rival, { count: 10, startIndex: 1 })).totalResults).toBe(0);
    expect(membershipOf(harness, harness.acme, ada.id)).toEqual([["member", "active"]]);
  });
});
