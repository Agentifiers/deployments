import { describe, expect, test } from "bun:test";
import { makeOrganizationStandingRepository } from "../organization-standing/repository.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import { INSTALL_DEFAULTS, OPERATOR, holdKey } from "../organization-standing/test-support.ts";
import { makeTenancyPersistence } from "../tenancy-persistence-composition.ts";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import type { OrganizationCreationPolicy } from "./organization-creation-policy.ts";
import {
  PERSON,
  createAs,
  creatorsMeetBeforeWriting,
  signedUpPerson,
} from "./organization-creation-test-support.ts";

const HOSTED: OrganizationCreationPolicy = { quotaPerPrincipal: 2, requireVerifiedEmail: true };

async function harness(
  policy: OrganizationCreationPolicy,
  options: { readonly emailVerified?: boolean } = {},
) {
  const store = makeTenancyTestDatabase();
  for (const record of signedUpPerson(PERSON)) {
    await store.database.putRecord(record);
  }
  const tenancyOver = (database: DynamoDatabaseService) =>
    makeTenancyPersistence({ database, organizationCreation: policy });
  const tenancy = tenancyOver(store.database);
  const outcome = (creating: Promise<{ readonly name: string }>) =>
    creating.then(
      (organization) => ({ created: organization.name }),
      (cause: { readonly code: string; readonly kind: string }) => ({
        refused: [cause.kind, cause.code],
      }),
    );
  const signedIn = options.emailVerified === false ? {} : { emailVerified: true as const };
  const create = (name: string, identity: Parameters<typeof createAs>[2] = {}) =>
    outcome(tenancy.organizations.create(createAs(PERSON, name, { ...signedIn, ...identity })));
  const race = (names: readonly string[]) => {
    const racing = tenancyOver(creatorsMeetBeforeWriting(names.length)(store.database));
    return Promise.all(
      names.map((name) => outcome(racing.organizations.create(createAs(PERSON, name, signedIn)))),
    );
  };
  const creations = () =>
    [...store.records.values()].flatMap((record) =>
      record.itemType === "principal-organization-creations"
        ? [[record.data.principalId, record.data.organizationsCreated, record.data.version]]
        : [],
    );
  return { create, creations, race, store, tenancy };
}

describe("organization creation fences", () => {
  test("refuses a person whose token does not carry a verified email where platform identity signs people in", async () => {
    const { create, creations } = await harness(HOSTED, { emailVerified: false });

    expect(await create("Unverified")).toEqual({
      refused: ["forbidden", "email_verification_required"],
    });
    expect(creations()).toEqual([]);
  });

  test("counts every organization a person creates and refuses the one past the quota", async () => {
    const { create, creations } = await harness(HOSTED);

    expect([await create("First"), await create("Second"), await create("Third")]).toEqual([
      { created: "First" },
      { created: "Second" },
      { refused: ["forbidden", "organization_quota_reached"] },
    ]);
    expect(creations()).toEqual([[PERSON, 2, 2]]);
  });

  test("keeps the count after the person's organizations are gone", async () => {
    const { create, store } = await harness(HOSTED);
    await create("First");
    await create("Second");
    for (const [storageKey, record] of store.records) {
      if (record.pk.startsWith("ORG#")) store.records.delete(storageKey);
    }

    expect(await create("Recreated")).toEqual({
      refused: ["forbidden", "organization_quota_reached"],
    });
  });

  test("refuses a person while an organization they own is held, until the hold is released", async () => {
    const { create, store, tenancy } = await harness({
      quotaPerPrincipal: null,
      requireVerifiedEmail: true,
    });
    const owned = await tenancy.organizations.create(createAs(PERSON, "Owned"));
    const standing = makeOrganizationStandingRepository({
      database: store.database,
      installDefaults: INSTALL_DEFAULTS,
    });
    const hold = { actor: OPERATOR, key: holdKey("abuse-review"), organizationId: owned.id };
    await standing.placeHold({ ...hold, customerMessage: "Under review.", reason: "abuse" });
    const whileHeld = await create("Evasion");
    await standing.releaseHold(hold);

    expect([whileHeld, await create("After release")]).toEqual([
      { refused: ["forbidden", "organization_creation_held"] },
      { created: "After release" },
    ]);
  });

  test("counts a held organization the person administers, but not one they only belong to", async () => {
    const { create, store, tenancy } = await harness({
      quotaPerPrincipal: null,
      requireVerifiedEmail: true,
    });
    const held = await tenancy.organizations.create(createAs(PERSON, "Held"));
    await makeOrganizationStandingRepository({
      database: store.database,
      installDefaults: INSTALL_DEFAULTS,
    }).placeHold({
      actor: OPERATOR,
      customerMessage: "Under review.",
      key: holdKey("abuse-review"),
      organizationId: held.id,
      reason: "abuse",
    });
    const asRole = async (role: "admin" | "member", name: string) => {
      for (const [storageKey, record] of store.records) {
        if (record.itemType === "organization-member" && record.data.organizationId === held.id) {
          store.records.set(storageKey, { ...record, data: { ...record.data, role } });
        }
      }
      return create(name);
    };

    expect([await asRole("admin", "As admin"), await asRole("member", "As member")]).toEqual([
      { refused: ["forbidden", "organization_creation_held"] },
      { created: "As member" },
    ]);
  });

  test("exempts platform administrators from every fence and leaves their count unwritten", async () => {
    const { create, creations } = await harness(
      { quotaPerPrincipal: 0, requireVerifiedEmail: true },
      { emailVerified: false },
    );

    expect(await create("Operator org", { platformRole: "administrator" })).toEqual({
      created: "Operator org",
    });
    expect(await create("Person org")).toEqual({
      refused: ["forbidden", "email_verification_required"],
    });
    expect(creations()).toEqual([]);
  });

  test("admits exactly one of two concurrent creates for the last allowed organization", async () => {
    const { create, creations, race } = await harness(HOSTED);
    await create("First");

    const outcomes = await race(["Racer A", "Racer B"]);

    expect(outcomes.filter((outcome) => "created" in outcome)).toHaveLength(1);
    expect(outcomes.filter((outcome) => "refused" in outcome)).toEqual([
      { refused: ["forbidden", "organization_quota_reached"] },
    ]);
    expect(creations()).toEqual([[PERSON, 2, 2]]);
  });

  test("leaves an installation without a policy unchanged apart from the count", async () => {
    const { create, creations } = await harness(
      { quotaPerPrincipal: null, requireVerifiedEmail: false },
      { emailVerified: false },
    );

    expect([await create("One"), await create("Two"), await create("Three")]).toEqual([
      { created: "One" },
      { created: "Two" },
      { created: "Three" },
    ]);
    expect(creations()).toEqual([[PERSON, 3, 3]]);
  });
});
