import { describe, expect, test } from "bun:test";
import {
  activeOwnerCount,
  invitableRoles,
  invitationActions,
  isSelfDemotion,
  memberActions,
  type MemberActor,
  type MemberSubject,
} from "./roles.ts";

const OWNER: MemberActor = { platformAdministrator: false, principalId: "A", role: "owner" };
const ADMIN: MemberActor = { platformAdministrator: false, principalId: "B", role: "admin" };
const OPERATOR: MemberActor = { platformAdministrator: true, principalId: "C" };

const owner = (principalId: string): MemberSubject => ({
  principalId,
  role: "owner",
  status: "active",
});

describe("memberActions", () => {
  test("keeps the sole active owner, even for that owner", () => {
    const reason = "An organization needs at least one owner. Make another member an owner first.";
    expect(memberActions(owner("A"), OWNER, 1)).toEqual({
      assignableRoles: [],
      changeRole: { enabled: false, reason },
      remove: { enabled: false, reason },
      self: true,
    });
  });

  test("reserves owners for owners", () => {
    const reason = "Only an owner can change or remove an owner.";
    expect(memberActions(owner("A"), ADMIN, 2)).toEqual({
      assignableRoles: [],
      changeRole: { enabled: false, reason },
      remove: { enabled: false, reason },
      self: false,
    });
  });

  test("lets admins manage non-owners without granting owner", () => {
    expect(memberActions({ principalId: "D", role: "member", status: "active" }, ADMIN, 1)).toEqual(
      {
        assignableRoles: ["admin", "billing", "member", "viewer"],
        changeRole: { enabled: true },
        remove: { enabled: true },
        self: false,
      },
    );
  });

  test("lets a platform administrator without a role manage a second owner", () => {
    expect(memberActions(owner("A"), OPERATOR, 2)).toEqual({
      assignableRoles: ["owner", "admin", "billing", "member", "viewer"],
      changeRole: { enabled: true },
      remove: { enabled: true },
      self: false,
    });
  });

  test("freezes removed members and refuses roles that cannot manage members", () => {
    const removed = memberActions({ principalId: "D", role: "admin", status: "removed" }, OWNER, 1);
    expect(removed.changeRole).toEqual({
      enabled: false,
      reason: "Removed members cannot change.",
    });
    const viewer: MemberActor = { platformAdministrator: false, principalId: "E", role: "viewer" };
    expect(
      memberActions({ principalId: "D", role: "member", status: "active" }, viewer, 1).remove,
    ).toEqual({ enabled: false, reason: "Only an owner or admin can change members." });
  });
});

describe("activeOwnerCount", () => {
  const members: MemberSubject[] = [
    owner("A"),
    { principalId: "B", role: "owner", status: "removed" },
    { principalId: "C", role: "admin", status: "active" },
  ];

  test("counts active owners once every page is read", () => {
    expect(activeOwnerCount(members, true)).toBe(1);
    expect(activeOwnerCount(members, false)).toBeUndefined();
  });
});

describe("invitableRoles", () => {
  test("offers owner only to owners and platform administrators", () => {
    expect(invitableRoles(ADMIN)).toEqual(["admin", "billing", "member", "viewer"]);
    expect(invitableRoles(OWNER)).toEqual(["owner", "admin", "billing", "member", "viewer"]);
    expect(
      invitableRoles({ platformAdministrator: false, principalId: "E", role: "member" }),
    ).toEqual([]);
  });
});

describe("the billing role without billing", () => {
  test("is not offered to invite or assign", () => {
    expect(invitableRoles(OWNER, false)).toEqual(["owner", "admin", "member", "viewer"]);
    expect(
      memberActions({ principalId: "D", role: "member", status: "active" }, ADMIN, 1, false)
        .assignableRoles,
    ).toEqual(["admin", "member", "viewer"]);
  });

  test("stays a choice for a member who already holds it", () => {
    expect(
      memberActions({ principalId: "D", role: "billing", status: "active" }, ADMIN, 1, false)
        .assignableRoles,
    ).toEqual(["admin", "billing", "member", "viewer"]);
  });
});

describe("invitationActions", () => {
  test("lets only owners and platform administrators revoke an owner invitation", () => {
    expect([
      invitationActions({ role: "owner" }, ADMIN),
      invitationActions({ role: "owner" }, OWNER),
      invitationActions({ role: "owner" }, OPERATOR),
      invitationActions({ role: "admin" }, ADMIN),
    ]).toEqual([
      { revoke: { enabled: false, reason: "Only an owner can revoke an owner invitation." } },
      { revoke: { enabled: true } },
      { revoke: { enabled: true } },
      { revoke: { enabled: true } },
    ]);
  });
});
describe("isSelfDemotion", () => {
  test("asks for confirmation only when the actor lowers their own owner or admin role", () => {
    const self = memberActions(owner("A"), OWNER, 2);
    const other = memberActions(owner("X"), OWNER, 2);
    expect([
      isSelfDemotion(self, "owner", "admin"),
      isSelfDemotion(self, "admin", "viewer"),
      isSelfDemotion(self, "admin", "owner"),
      isSelfDemotion(self, "member", "viewer"),
      isSelfDemotion(other, "owner", "viewer"),
    ]).toEqual([true, true, false, false, false]);
  });
});
