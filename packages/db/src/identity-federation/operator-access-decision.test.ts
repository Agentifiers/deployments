import { describe, expect, test } from "bun:test";
import type { OrganizationOperatorAccess } from "../records/operator-access.ts";
import { decideOrganizationAccess, type OrganizationAccess } from "./access.ts";
import { ORGANIZATION, OTHER_ORGANIZATION, id } from "./test-support.ts";

const PRINCIPAL = id("01ARZ3NDEKTSV4RRFFQ69G5FE1");
const GRANT = id("01ARZ3NDEKTSV4RRFFQ69G5FE2");
const NOW = new Date("2026-11-03T12:00:00.000Z");
const LATER = "2026-11-03T13:00:00.000Z";
const EARLIER = "2026-11-03T11:59:59.999Z";

type Record = "closed" | "expired" | "none" | "open";
type Scope = "other-organization" | "this-organization";

function stored(state: Record, scope: Scope): OrganizationOperatorAccess | undefined {
  if (state === "none") return undefined;
  return {
    createdAt: "2026-11-03T11:00:00.000Z",
    expiresAt: state === "expired" ? EARLIER : LATER,
    grantId: GRANT,
    openedAt: "2026-11-03T11:00:00.000Z",
    // The record was granted for this organization; the request may select another one.
    organizationId: scope === "this-organization" ? ORGANIZATION : OTHER_ORGANIZATION,
    principalId: PRINCIPAL,
    reason: "Support case",
    state:
      state === "closed"
        ? { closedAt: "2026-11-03T11:30:00.000Z", kind: "closed" }
        : { kind: "open" },
    updatedAt: "2026-11-03T11:00:00.000Z",
    version: 1,
  };
}

const ADMITTED: OrganizationAccess = {
  kind: "platform-administrator",
  operatorAccess: { expiresAt: LATER, grantId: GRANT, organizationId: ORGANIZATION },
};
const MEMBER: OrganizationAccess = { kind: "member", role: "admin" };
const REQUIRED: OrganizationAccess = { kind: "operator-access-required" };
const DENIED: OrganizationAccess = { kind: "denied" };

/** [member, administrator, record, request scope, decision] */
const TABLE: readonly (readonly [boolean, boolean, Record, Scope, OrganizationAccess])[] = [
  [false, false, "none", "this-organization", DENIED],
  [false, false, "open", "this-organization", DENIED],
  [false, false, "open", "other-organization", DENIED],
  [false, false, "expired", "this-organization", DENIED],
  [false, false, "closed", "this-organization", DENIED],
  [false, true, "none", "this-organization", REQUIRED],
  [false, true, "open", "this-organization", ADMITTED],
  [false, true, "open", "other-organization", REQUIRED],
  [false, true, "expired", "this-organization", REQUIRED],
  [false, true, "expired", "other-organization", REQUIRED],
  [false, true, "closed", "this-organization", REQUIRED],
  [false, true, "closed", "other-organization", REQUIRED],
  [true, false, "none", "this-organization", MEMBER],
  [true, false, "open", "this-organization", MEMBER],
  [true, true, "none", "this-organization", MEMBER],
  [true, true, "open", "this-organization", MEMBER],
  [true, true, "open", "other-organization", MEMBER],
  [true, true, "expired", "this-organization", MEMBER],
  [true, true, "closed", "this-organization", MEMBER],
];

describe("operator access decision", () => {
  test.each(TABLE)(
    "member=%p administrator=%p record=%p scope=%p",
    (member, platformAdministrator, record, scope, decision) => {
      expect(
        decideOrganizationAccess({
          grant: undefined,
          member: member ? { role: "admin", status: "active" } : undefined,
          now: NOW,
          operatorAccess: stored(record, scope),
          organizationId: ORGANIZATION,
          platformAdministrator,
          principalId: PRINCIPAL,
          provider: undefined,
        }),
      ).toEqual(decision);
    },
  );

  test("a removed or invited administrator member still needs operator access", () => {
    for (const status of ["invited", "removed"] as const) {
      expect(
        decideOrganizationAccess({
          grant: undefined,
          member: { role: "owner", status },
          now: NOW,
          operatorAccess: undefined,
          organizationId: ORGANIZATION,
          platformAdministrator: true,
          principalId: PRINCIPAL,
          provider: undefined,
        }),
      ).toEqual(REQUIRED);
    }
  });

  test("a record held by another principal never admits", () => {
    const record = stored("open", "this-organization");
    expect(
      decideOrganizationAccess({
        grant: undefined,
        member: undefined,
        now: NOW,
        operatorAccess: record && { ...record, principalId: id("01ARZ3NDEKTSV4RRFFQ69G5FE9") },
        organizationId: ORGANIZATION,
        platformAdministrator: true,
        principalId: PRINCIPAL,
        provider: undefined,
      }),
    ).toEqual(REQUIRED);
  });
});
