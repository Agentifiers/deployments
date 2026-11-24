import { describe, expect, test } from "bun:test";
import {
  EXISTING_PRINCIPAL,
  ORGANIZATION,
  START,
  id,
  memberRecord,
  organizationRecord,
} from "./identity-federation/test-support.ts";
import { memberActivation, memberRemoval } from "./organization-membership-changes.ts";

const AT = "2026-10-09T08:00:00.000Z";

describe("memberActivation", () => {
  test("reactivates a removed admin from the directory with the role it is given", () => {
    const removed = memberRecord(EXISTING_PRINCIPAL, "removed", "admin");

    const change = memberActivation({
      at: AT,
      existing: removed,
      organizationId: ORGANIZATION,
      principalId: EXISTING_PRINCIPAL,
      role: "member",
      source: { kind: "scim" },
    });

    expect(change.member.data).toEqual({
      createdAt: START,
      joinedAt: AT,
      organizationId: ORGANIZATION,
      principalId: EXISTING_PRINCIPAL,
      role: "member",
      status: "active",
      updatedAt: AT,
      version: 2,
    });
    expect(change.operations).toEqual([
      { kind: "put", previousRecord: removed, record: change.member },
    ]);
    expect(change.events).toEqual([
      {
        aggregateId: EXISTING_PRINCIPAL,
        aggregateType: "organization-member",
        aggregateVersion: 2,
        eventType: "organization-member.added",
        organizationId: ORGANIZATION,
        payload: {
          principalId: EXISTING_PRINCIPAL,
          role: "member",
          source: "scim",
          status: "active",
        },
      },
    ]);
  });

  test("creates a new membership with a create-only put", () => {
    const change = memberActivation({
      at: AT,
      existing: undefined,
      organizationId: ORGANIZATION,
      principalId: EXISTING_PRINCIPAL,
      role: "viewer",
      source: { actorPrincipalId: id("01ARZ3NDEKTSV4RRFFQ69G5FC9"), kind: "member-api" },
    });

    expect(change.operations).toEqual([{ kind: "put", record: change.member }]);
    expect(change.member.data).toEqual({
      createdAt: AT,
      joinedAt: AT,
      organizationId: ORGANIZATION,
      principalId: EXISTING_PRINCIPAL,
      role: "viewer",
      status: "active",
      updatedAt: AT,
      version: 1,
    });
    expect(change.events.map((event) => event.payload)).toEqual([
      { principalId: EXISTING_PRINCIPAL, role: "viewer", status: "active" },
    ]);
  });
});

describe("memberRemoval", () => {
  test("a directory removal records no removing principal and revises the organization", () => {
    const organization = organizationRecord();
    const previous = memberRecord(EXISTING_PRINCIPAL, "active", "member");

    const change = memberRemoval({ at: AT, organization, previous, source: { kind: "scim" } });

    expect(change.member.data).toEqual({
      createdAt: START,
      organizationId: ORGANIZATION,
      principalId: EXISTING_PRINCIPAL,
      removedAt: AT,
      role: "member",
      status: "removed",
      updatedAt: AT,
      version: 2,
    });
    expect(change.operations).toEqual([
      { kind: "put", previousRecord: previous, record: change.member },
      {
        kind: "put",
        previousRecord: organization,
        record: expect.objectContaining({
          data: { ...organization.data, updatedAt: AT, version: 2 },
        }),
      },
    ]);
    expect(change.events).toEqual([
      {
        aggregateId: EXISTING_PRINCIPAL,
        aggregateType: "organization-member",
        aggregateVersion: 2,
        eventType: "organization-member.removed",
        organizationId: ORGANIZATION,
        payload: {
          principalId: EXISTING_PRINCIPAL,
          role: "member",
          source: "scim",
          status: "removed",
        },
      },
      {
        aggregateId: ORGANIZATION,
        aggregateType: "organization",
        aggregateVersion: 2,
        eventType: "organization.membership-revised",
        organizationId: ORGANIZATION,
        payload: { principalId: EXISTING_PRINCIPAL, source: "scim", status: "removed" },
      },
    ]);
  });

  test("a member-api removal records the removing principal", () => {
    const remover = id("01ARZ3NDEKTSV4RRFFQ69G5FC9");

    const change = memberRemoval({
      at: AT,
      organization: organizationRecord(),
      previous: memberRecord(EXISTING_PRINCIPAL, "active", "member"),
      source: { actorPrincipalId: remover, kind: "member-api" },
    });

    expect(change.member.data.removedByPrincipalId).toBe(remover);
    expect(change.events.map((event) => event.payload)).toEqual([
      { principalId: EXISTING_PRINCIPAL, role: "member", status: "removed" },
      { principalId: EXISTING_PRINCIPAL, status: "removed" },
    ]);
  });
});
