import { describe, expect, test } from "bun:test";
import type { FederatedAuthentication } from "../records/identity-federation.ts";
import { openOperatorAccessRecord } from "../operator-access/test-support.ts";
import { federatedGrantRecord, federatedSessionSatisfies, organizationAccess } from "./access.ts";
import {
  CONNECTION,
  ISSUER,
  ORGANIZATION,
  START,
  federationMemoryDatabase,
  id,
  memberRecord,
  providerRecord,
} from "./test-support.ts";

const MEMBER = id("01ARZ3NDEKTSV4RRFFQ69G5FD1");
const TOKEN_SESSION = id("01ARZ3NDEKTSV4RRFFQ69G5FD2");
const NOW = new Date("2026-10-08T13:00:00.000Z");
const REQUIRED = { enforcement: "required", kind: "active" } as const;

const authentication: FederatedAuthentication = {
  authenticatedAt: START,
  connectionId: CONNECTION,
  issuer: ISSUER,
  method: "federated",
  organizationId: ORGANIZATION,
  subject: "00u-member",
};

function grant(
  overrides: { tokenSessionExpiresAt?: string; authentication?: FederatedAuthentication } = {},
) {
  return federatedGrantRecord({
    authentication: overrides.authentication ?? authentication,
    createdAt: START,
    principalId: MEMBER,
    tokenSessionExpiresAt: overrides.tokenSessionExpiresAt ?? "2026-10-09T12:00:00.000Z",
    tokenSessionId: TOKEN_SESSION,
  });
}

async function access(
  records: Parameters<typeof federationMemoryDatabase>[0],
  input: { platformAdministrator?: boolean; tokenSessionId?: typeof TOKEN_SESSION } = {},
) {
  return organizationAccess(federationMemoryDatabase(records).database, {
    now: NOW,
    organizationId: ORGANIZATION,
    platformAdministrator: input.platformAdministrator ?? false,
    principalId: MEMBER,
    ...(input.tokenSessionId ? { tokenSessionId: input.tokenSessionId } : {}),
  });
}

describe("organizationAccess truth table", () => {
  test("a password token in an enforced organization needs SSO", async () => {
    expect(
      await access([providerRecord({ state: REQUIRED }), memberRecord(MEMBER, "active", "member")]),
    ).toEqual({
      kind: "sso-required",
    });
  });

  test("a matching federated grant passes with the member role", async () => {
    expect(
      await access(
        [providerRecord({ state: REQUIRED }), memberRecord(MEMBER, "active", "member"), grant()],
        { tokenSessionId: TOKEN_SESSION },
      ),
    ).toEqual({ kind: "member", role: "member" });
  });

  test("an expired grant needs SSO again", async () => {
    expect(
      await access(
        [
          providerRecord({ state: REQUIRED }),
          memberRecord(MEMBER, "active", "member"),
          grant({ tokenSessionExpiresAt: "2026-10-08T12:30:00.000Z" }),
        ],
        { tokenSessionId: TOKEN_SESSION },
      ),
    ).toEqual({ kind: "sso-required" });
  });

  test("a grant from a replaced connection needs SSO again", async () => {
    expect(
      await access(
        [
          providerRecord({ connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FD9"), state: REQUIRED }),
          memberRecord(MEMBER, "active", "member"),
          grant(),
        ],
        { tokenSessionId: TOKEN_SESSION },
      ),
    ).toEqual({ kind: "sso-required" });
  });

  test("owners keep break-glass access without a grant", async () => {
    expect(
      await access([providerRecord({ state: REQUIRED }), memberRecord(MEMBER, "active", "owner")]),
    ).toEqual({
      kind: "member",
      role: "owner",
    });
  });

  test("platform administrators pass without membership or SSO only under operator access", async () => {
    expect(
      await access([providerRecord({ state: REQUIRED })], { platformAdministrator: true }),
    ).toEqual({ kind: "operator-access-required" });
    expect(
      await access(
        [
          providerRecord({ state: REQUIRED }),
          openOperatorAccessRecord({ organizationId: ORGANIZATION, principalId: MEMBER }),
        ],
        { platformAdministrator: true },
      ),
    ).toMatchObject({ kind: "platform-administrator" });
  });

  test("optional enforcement and disabled connections never require SSO", async () => {
    expect(await access([providerRecord(), memberRecord(MEMBER, "active", "viewer")])).toEqual({
      kind: "member",
      role: "viewer",
    });
    expect(
      await access([
        providerRecord({ state: { disabledAt: START, kind: "disabled" } }),
        memberRecord(MEMBER, "active", "viewer"),
      ]),
    ).toEqual({ kind: "member", role: "viewer" });
  });

  test("removed and invited members are denied", async () => {
    expect(await access([providerRecord(), memberRecord(MEMBER, "removed", "admin")])).toEqual({
      kind: "denied",
    });
    expect(await access([providerRecord(), memberRecord(MEMBER, "invited", "admin")])).toEqual({
      kind: "denied",
    });
  });
});

describe("federated grants", () => {
  test("expire with the token chain, capped twelve hours after authentication", () => {
    expect(grant().data.expiresAt).toBe("2026-10-09T00:00:00.000Z");
    expect(grant({ tokenSessionExpiresAt: "2026-10-08T12:05:00.000Z" }).data.expiresAt).toBe(
      "2026-10-08T12:05:00.000Z",
    );
  });

  test("a browser session satisfies only its own organization's current connection", () => {
    const provider = providerRecord().data;
    expect(federatedSessionSatisfies({ authentication, now: NOW, provider })).toBe(true);
    expect(
      federatedSessionSatisfies({
        authentication,
        now: new Date("2026-10-09T00:00:00.000Z"),
        provider,
      }),
    ).toBe(false);
    expect(
      federatedSessionSatisfies({
        authentication,
        now: NOW,
        provider: { ...provider, connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FD9") },
      }),
    ).toBe(false);
    expect(
      federatedSessionSatisfies({ authentication: { method: "password" }, now: NOW, provider }),
    ).toBe(false);
  });
});
