import { describe, expect, test } from "bun:test";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import {
  ADMINISTRATOR,
  PERSON,
  signedUpPerson,
} from "../tenancy/organization-creation-test-support.ts";
import { makePrincipalStatusRepository } from "./principal-status.ts";

const NOW = new Date("2026-10-18T12:00:00.000Z");

async function harness() {
  const store = makeTenancyTestDatabase();
  for (const record of signedUpPerson(PERSON)) await store.database.putRecord(record);
  const statuses = makePrincipalStatusRepository({ database: store.database, now: () => NOW });
  const signInState = () =>
    [...store.records.values()].flatMap((record) => {
      switch (record.itemType) {
        case "principal":
          return [["principal", record.data.status, record.data.version]];
        case "principal-security-state":
          return [["epoch", record.data.sessionEpoch, record.data.version]];
        case "identity-bff-revocation-fence":
          return [["fence", record.data.principalStatus, record.data.sessionEpoch]];
        default:
          return [];
      }
    });
  const events = () =>
    [...store.records.values()].flatMap((record) =>
      record.itemType === "identity-security-event"
        ? [[record.data.eventType, record.data.actor?.id, record.data.payload]]
        : [],
    );
  return { events, signInState, statuses };
}

describe("principal status", () => {
  test("disabling ends the person's sessions once, and a repeat changes nothing", async () => {
    const { events, signInState, statuses } = await harness();
    const disable = {
      actorPrincipalId: ADMINISTRATOR,
      principalId: PERSON,
      reason: "Fraudulent sign-ups",
      status: "disabled",
    } as const;

    expect([await statuses.setStatus(disable), await statuses.setStatus(disable)]).toEqual([
      { changed: true, principalId: PERSON, status: "disabled", updatedAt: NOW.toISOString() },
      { changed: false, principalId: PERSON, status: "disabled", updatedAt: NOW.toISOString() },
    ]);
    expect(signInState()).toEqual([
      ["principal", "disabled", 2],
      ["epoch", 4, 2],
      ["fence", "disabled", 4],
    ]);
    expect(events()).toEqual([
      [
        "identity.principal-disabled",
        ADMINISTRATOR,
        { reason: "Fraudulent sign-ups", status: "disabled" },
      ],
      ["identity.sessions-invalidated", ADMINISTRATOR, {}],
    ]);
  });

  test("re-enabling restores sign-in without reviving the ended sessions", async () => {
    const { signInState, statuses } = await harness();
    const change = { actorPrincipalId: ADMINISTRATOR, principalId: PERSON, reason: "Appeal" };
    await statuses.setStatus({ ...change, status: "disabled" });

    expect(await statuses.setStatus({ ...change, status: "active" })).toEqual({
      changed: true,
      principalId: PERSON,
      status: "active",
      updatedAt: NOW.toISOString(),
    });
    expect(signInState()).toEqual([
      ["principal", "active", 3],
      ["epoch", 4, 2],
      ["fence", "active", 4],
    ]);
  });

  test("refuses an administrator disabling themselves and an unknown principal", async () => {
    const { statuses } = await harness();
    const refusal = (cause: { readonly code: string; readonly kind: string }) => [
      cause.kind,
      cause.code,
    ];

    expect(
      await Promise.all([
        statuses
          .setStatus({
            actorPrincipalId: ADMINISTRATOR,
            principalId: ADMINISTRATOR,
            reason: "Oops",
            status: "disabled",
          })
          .catch(refusal),
        statuses
          .setStatus({
            actorPrincipalId: PERSON,
            principalId: ADMINISTRATOR,
            reason: "Unknown",
            status: "disabled",
          })
          .catch(refusal),
      ]),
    ).toEqual([
      ["forbidden", "cannot_disable_self"],
      ["not-found", "principal_not_found"],
    ]);
  });
});
