import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import type { OrganizationMember, OrganizationRole } from "../tenancy-contracts.ts";
import {
  planDirectoryChange,
  planDirectoryCreate,
  planDirectoryDelete,
  type ChangeFacts,
  type ChangePlan,
  type CreateFacts,
  type CreatePlan,
  type DeletePlan,
  type DirectoryUserChange,
  type NewDirectoryUser,
} from "./user-plan.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const ADA = ulid("01ARZ3NDEKTSV4RRFFQ69G5FD0");
const GRACE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FD1");

const member = (role: OrganizationRole, status: "active" | "invited" | "removed") => ({
  role,
  status,
});

const newUser = { active: true, email: "ada@acme.example", userName: "ada@acme.example" };

const createFacts = (overrides: Partial<CreateFacts> = {}): CreateFacts => ({
  defaultRole: "viewer",
  domainVerified: true,
  externalIdOwner: undefined,
  principal: { kind: "absent" },
  userNameOwner: undefined,
  ...overrides,
});

const present = (overrides: Partial<Extract<CreateFacts["principal"], { kind: "present" }>>) => ({
  eligible: true,
  id: ADA,
  kind: "present" as const,
  mapped: false,
  membership: undefined,
  ...overrides,
});

describe("planDirectoryCreate", () => {
  test.each<[string, CreateFacts, NewDirectoryUser, CreatePlan]>([
    [
      "an unknown email in a verified domain provisions an active member",
      createFacts(),
      newUser,
      { kind: "provision", membership: { kind: "activate", role: "viewer" } },
    ],
    [
      "an inactive new user is provisioned without a membership",
      createFacts(),
      { ...newUser, active: false },
      { kind: "provision", membership: { kind: "keep" } },
    ],
    [
      "an email outside the organization's verified domains is refused",
      createFacts({ domainVerified: false }),
      newUser,
      { kind: "refused", reason: "email_domain_not_verified" },
    ],
    [
      "a userName another user holds is refused",
      createFacts({ userNameOwner: GRACE }),
      newUser,
      { kind: "refused", reason: "user_exists" },
    ],
    [
      "an externalId another user holds is refused",
      createFacts({ externalIdOwner: GRACE }),
      { ...newUser, externalId: "00u1" },
      { kind: "refused", reason: "external_id_taken" },
    ],
    [
      "an existing person without a membership is adopted as a default-role member",
      createFacts({ principal: present({}) }),
      newUser,
      { kind: "adopt", membership: { kind: "activate", role: "viewer" }, principalId: ADA },
    ],
    [
      "an existing active admin is adopted with the membership untouched",
      createFacts({ principal: present({ membership: member("admin", "active") }) }),
      newUser,
      { kind: "adopt", membership: { kind: "keep" }, principalId: ADA },
    ],
    [
      "a removed admin is reactivated with the default role",
      createFacts({ principal: present({ membership: member("admin", "removed") }) }),
      newUser,
      { kind: "adopt", membership: { kind: "activate", role: "viewer" }, principalId: ADA },
    ],
    [
      "a disabled or service principal is refused",
      createFacts({ principal: present({ eligible: false }) }),
      newUser,
      { kind: "refused", reason: "principal_ineligible" },
    ],
    [
      "a person the directory already maps is refused",
      createFacts({ principal: present({ mapped: true }) }),
      newUser,
      { kind: "refused", reason: "user_exists" },
    ],
  ])("%s", (_name, facts, input, expected) => {
    expect(planDirectoryCreate(facts, input)).toEqual(expected);
  });
});

const changeFacts = (overrides: Partial<ChangeFacts> = {}): ChangeFacts => ({
  defaultRole: "member",
  externalIdOwner: undefined,
  mapping: { externalId: "00u1", origin: "provisioned", userName: "ada@acme.example" },
  membership: member("member", "active"),
  otherMemberships: false,
  principal: { displayName: "Ada" },
  userNameOwner: undefined,
  ...overrides,
});

const sameMapping = { externalId: "00u1", userName: "ada@acme.example" };

describe("planDirectoryChange", () => {
  test.each<[string, ChangeFacts, DirectoryUserChange, ChangePlan]>([
    [
      "deactivating an active member removes the membership",
      changeFacts(),
      { active: false },
      {
        displayName: undefined,
        kind: "write",
        mapping: sameMapping,
        membership: { kind: "remove" },
      },
    ],
    [
      "deactivating an active owner is refused",
      changeFacts({ membership: member("owner", "active") }),
      { active: false },
      { kind: "refused", reason: "protected_role" },
    ],
    [
      "deactivating an active admin is refused",
      changeFacts({ membership: member("admin", "active") }),
      { active: false },
      { kind: "refused", reason: "protected_role" },
    ],
    [
      "reactivating a removed admin grants the default role",
      changeFacts({ membership: member("admin", "removed") }),
      { active: true },
      {
        displayName: undefined,
        kind: "write",
        mapping: sameMapping,
        membership: { kind: "activate", role: "member" },
      },
    ],
    [
      "deactivating a removed member changes nothing",
      changeFacts({ membership: member("member", "removed") }),
      { active: false },
      { kind: "unchanged" },
    ],
    [
      "a new userName updates only the mapping",
      changeFacts(),
      { userName: "ada.l@acme.example" },
      {
        displayName: undefined,
        kind: "write",
        mapping: { externalId: "00u1", userName: "ada.l@acme.example" },
        membership: { kind: "keep" },
      },
    ],
    [
      "a userName another user holds is refused",
      changeFacts({ userNameOwner: GRACE }),
      { userName: "grace@acme.example" },
      { kind: "refused", reason: "user_exists" },
    ],
    [
      "deactivating drops a userName another user holds and still removes the membership",
      changeFacts({ userNameOwner: GRACE }),
      { active: false, userName: "grace@acme.example" },
      {
        displayName: undefined,
        kind: "write",
        mapping: sameMapping,
        membership: { kind: "remove" },
      },
    ],
    [
      "deactivating drops a taken externalId and keeps the other mapping changes",
      changeFacts({ externalIdOwner: GRACE }),
      { active: false, externalId: "00u2", userName: "ada.l@acme.example" },
      {
        displayName: undefined,
        kind: "write",
        mapping: { externalId: "00u1", userName: "ada.l@acme.example" },
        membership: { kind: "remove" },
      },
    ],
    [
      "repeating a deactivation with a taken userName changes nothing",
      changeFacts({ membership: member("member", "removed"), userNameOwner: GRACE }),
      { active: false, userName: "grace@acme.example" },
      { kind: "unchanged" },
    ],
    [
      "an activation with a taken userName is refused",
      changeFacts({ membership: member("member", "removed"), userNameOwner: GRACE }),
      { active: true, userName: "grace@acme.example" },
      { kind: "refused", reason: "user_exists" },
    ],
    [
      "removing the externalId clears it from the mapping",
      changeFacts(),
      { externalId: null },
      {
        displayName: undefined,
        kind: "write",
        mapping: { externalId: undefined, userName: "ada@acme.example" },
        membership: { kind: "keep" },
      },
    ],
    [
      "an externalId another user holds is refused",
      changeFacts({ externalIdOwner: GRACE }),
      { externalId: "00u2" },
      { kind: "refused", reason: "external_id_taken" },
    ],
    [
      "a provisioned sole member's display name changes",
      changeFacts(),
      { displayName: "Ada Lovelace" },
      {
        displayName: "Ada Lovelace",
        kind: "write",
        mapping: sameMapping,
        membership: { kind: "keep" },
      },
    ],
    [
      "an adopted person's display name is left alone",
      changeFacts({ mapping: { ...sameMapping, origin: "adopted" } }),
      { displayName: "Ada Lovelace" },
      { kind: "unchanged" },
    ],
    [
      "a display name is left alone for someone in another organization",
      changeFacts({ otherMemberships: true }),
      { displayName: "Ada Lovelace" },
      { kind: "unchanged" },
    ],
    [
      "an admin's display name is left alone",
      changeFacts({ membership: member("admin", "active") }),
      { displayName: "Ada Lovelace" },
      { kind: "unchanged" },
    ],
    [
      "an owner's userName can still change",
      changeFacts({ membership: member("owner", "active") }),
      { active: true, userName: "boss@acme.example" },
      {
        displayName: undefined,
        kind: "write",
        mapping: { externalId: "00u1", userName: "boss@acme.example" },
        membership: { kind: "keep" },
      },
    ],
  ])("%s", (_name, facts, change, expected) => {
    expect(planDirectoryChange(facts, change)).toEqual(expected);
  });
});

describe("planDirectoryDelete", () => {
  test.each<[string, Pick<OrganizationMember["data"], "role" | "status"> | undefined, DeletePlan]>([
    [
      "an active member",
      member("member", "active"),
      { kind: "write", membership: { kind: "remove" } },
    ],
    [
      "a removed member",
      member("member", "removed"),
      { kind: "write", membership: { kind: "keep" } },
    ],
    ["a user without a membership", undefined, { kind: "write", membership: { kind: "keep" } }],
    ["an active owner", member("owner", "active"), { kind: "refused", reason: "protected_role" }],
    [
      "a removed admin",
      member("admin", "removed"),
      { kind: "write", membership: { kind: "keep" } },
    ],
  ])("deleting %s", (_name, membership, expected) => {
    expect(planDirectoryDelete(membership)).toEqual(expected);
  });
});
