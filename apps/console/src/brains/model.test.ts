import { describe, expect, test } from "bun:test";
import { BrainGrantResponse } from "@deployments-ai/api-contract/brains";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";
import { attemptAfterFailure, freshAttempt } from "../components/keyed-attempt.ts";
import { snapshotFor } from "../components/keyed-snapshot.ts";
import { PlatformApiError } from "../errors.ts";
import type { MemberView } from "../members/roles.ts";
import {
  activeRecord,
  BRAIN_RETRY_NOTICES,
  canCreateBrain,
  canOfferCompanyBrain,
  editBrainBody,
  grantablePeople,
  grantKindsFor,
  grantRequest,
  isBrainSlug,
  mountRefusal,
  revokeRefusal,
  slugFromName,
  type BrainGrant,
} from "./model.ts";

const ENV = "01K0000000000000000000000C";
const PROJECT = "01K0000000000000000000000B";
const AGENT = "01K0000000000000000000000D";

const decodeGrant = Schema.decodeUnknownSync(BrainGrantResponse);

function grant(
  id: string,
  permission: BrainGrant["permission"],
  target: Readonly<Record<string, string>>,
  status: BrainGrant["status"] = "active",
): BrainGrant {
  return decodeGrant({
    brainId: "01K0000000000000000000000E",
    createdAt: "2026-10-09T00:00:00.000Z",
    id,
    organizationId: "01K0000000000000000000000A",
    permission,
    status,
    target,
    updatedAt: "2026-10-09T00:00:00.000Z",
    version: 0,
  });
}

const owner = (id: string) =>
  grant(id, "owner", { principalId: "01K0000000000000000000000F", type: "principal" });

describe("canOfferCompanyBrain", () => {
  test("offers company Brains to owners and admins, the roles the create condition accepts", () => {
    // Mirrors activeMemberCondition(…, elevated) in packages/db/src/brains/authorization-conditions.ts.
    const offered = (["owner", "admin", "member", "viewer", "billing", undefined] as const).map(
      (organizationRole) =>
        canOfferCompanyBrain({
          capabilities: [],
          ...(organizationRole ? { organizationRole } : {}),
          platformRole: "administrator",
        }),
    );
    expect(offered).toEqual([true, true, false, false, false, false]);
  });
});

describe("canCreateBrain", () => {
  test("needs a membership, which a platform administrator outside the organization lacks", () => {
    expect([
      canCreateBrain({ capabilities: [], organizationRole: "member" }),
      canCreateBrain({ capabilities: [], platformRole: "administrator" }),
    ]).toEqual([true, false]);
  });
});

describe("slugFromName", () => {
  test("lowercases the name and joins its words with single hyphens", () => {
    expect(slugFromName("  QA Brain: Wave 4 / Crème brûlée  ")).toBe(
      "qa-brain-wave-4-creme-brulee",
    );
  });

  test("trims a hyphen left at the 80-character cut", () => {
    expect(slugFromName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });

  test("suggests a slug the contract accepts from a long name", () => {
    expect(isBrainSlug(slugFromName("a".repeat(200)))).toBe(true);
  });
});

describe("isBrainSlug", () => {
  test("applies the contract's pattern and its 80-character limit", () => {
    expect(
      ["qa-brain", "a".repeat(80), "a".repeat(81), "QA", "qa--brain", "-qa", ""].map(isBrainSlug),
    ).toEqual([true, true, false, false, false, false, false]);
  });
});

describe("editBrainBody", () => {
  const base = { name: "QA", sensitivity: "internal", slug: "qa", version: 3 } as const;

  test("sends only changed fields against the version the edit started from", () => {
    expect(editBrainBody(base, { name: " QA ", sensitivity: "restricted", slug: "qa" })).toEqual({
      expectedVersion: 3,
      sensitivity: "restricted",
    });
  });
});

describe("a Brain dialog after a 500", () => {
  test("resends the body it held, whatever the fields say now", () => {
    const first = freshAttempt();
    const sent = snapshotFor<string>(undefined, first.key, false, "taken");
    const next = attemptAfterFailure(
      first,
      new PlatformApiError("createBrain", { code: "internal_error", status: 500, title: "Error" }),
    );
    const resent = snapshotFor(sent, next.key, next.state === "resend", "free");
    expect([next.key === first.key, next.state, resent.value]).toEqual([true, "resend", "taken"]);
  });
});

describe("BRAIN_RETRY_NOTICES", () => {
  test("warns that a resent upload source is added again, since no claim refuses it", () => {
    expect(BRAIN_RETRY_NOTICES.uploadSource).toBe(
      "Submitting again sends this request unchanged. Nothing refuses a second upload source, so if the first attempt went through, a repeat adds another one. Leave unfinished reloads Sources so you can check before you open the dialog again.",
    );
  });
});

describe("a revoke after a 409", () => {
  const id = "01K00000000000000000000001";

  test("sends the version the refreshed list holds", () => {
    const first = freshAttempt();
    const sent = snapshotFor(undefined, first.key, false, activeRecord([owner(id)], id));
    const next = attemptAfterFailure(
      first,
      new PlatformApiError("revokeBrainGrant", {
        code: "brain_grant_version_conflict",
        status: 409,
        title: "Conflict",
      }),
    );
    const refreshed = activeRecord([{ ...owner(id), version: 1 }], id);
    expect(snapshotFor(sent, next.key, next.state === "resend", refreshed).value?.version).toBe(1);
  });

  test("finds nothing to revoke once the refreshed list shows it revoked, so the dialog closes", () => {
    expect(activeRecord([{ ...owner(id), status: "revoked" as const, version: 1 }], id)).toBe(
      undefined,
    );
  });
});

describe("grantRequest", () => {
  test("builds the contract body for an organization-role grant", () => {
    expect(
      grantRequest({ kind: "organization-role", organizationRole: "member", permission: "reader" }),
    ).toEqual({
      permission: "reader",
      target: { organizationRole: "member", type: "organization-role" },
    });
  });

  test("builds the contract body for an agent-definition grant", () => {
    expect(
      grantRequest({
        agentDefinitionId: AGENT,
        environmentId: ENV,
        kind: "agent-definition",
        permission: "read-write",
        projectId: PROJECT,
      }),
    ).toEqual({
      permission: "read-write",
      target: {
        agentDefinitionId: AGENT,
        environmentId: ENV,
        projectId: PROJECT,
        type: "agent-definition",
      },
    });
  });

  test("offers people and roles only on company Brains", () => {
    expect([grantKindsFor("company"), grantKindsFor("member-private")]).toEqual([
      ["principal", "organization-role", "agent-definition", "service-account"],
      ["agent-definition", "service-account"],
    ]);
  });
});

describe("revokeRefusal", () => {
  test("keeps the last active owner of a company Brain and allows revoking one of two", () => {
    const first = owner("01K00000000000000000000001");
    const second = owner("01K00000000000000000000002");
    const revoked = { ...owner("01K00000000000000000000003"), status: "revoked" as const };
    expect(revokeRefusal({ kind: "company" }, first, [first, revoked])).toBe(
      "A company Brain keeps at least one owner.",
    );
    expect(revokeRefusal({ kind: "company" }, first, [first, second])).toBeUndefined();
  });

  test("never revokes a private Brain's owner and allows revoking its agent grants", () => {
    const self = owner("01K00000000000000000000001");
    const agent = grant("01K00000000000000000000002", "read", {
      agentDefinitionId: AGENT,
      environmentId: ENV,
      projectId: PROJECT,
      type: "agent-definition",
    });
    expect([
      revokeRefusal({ kind: "member-private" }, self, [self, agent]),
      revokeRefusal({ kind: "member-private" }, agent, [self, agent]),
    ]).toEqual(["A private Brain always keeps its owner.", undefined]);
  });
});

describe("mountRefusal", () => {
  const target = { agentDefinitionId: AGENT, environmentId: ENV, projectId: PROJECT };
  const agentGrant = (permission: "read" | "read-write", environmentId = ENV) =>
    grant("01K00000000000000000000009", permission, {
      agentDefinitionId: AGENT,
      environmentId,
      projectId: PROJECT,
      type: "agent-definition",
    });

  test("needs an agent grant in the mount's environment", () => {
    expect(mountRefusal(target, "read", [agentGrant("read", "01K0000000000000000000000Z")])).toBe(
      "Grant this agent access to the Brain first. A mount needs an agent grant in this environment.",
    );
  });

  test("allows a read mount on a read grant and refuses a read-write mount on it", () => {
    expect([
      mountRefusal(target, "read", [agentGrant("read")]),
      mountRefusal(target, "read-write", [agentGrant("read")]),
      mountRefusal(target, "read-write", [agentGrant("read-write")]),
    ]).toEqual([
      undefined,
      "The agent's grant is read-only, so the mount can only read.",
      undefined,
    ]);
  });
});

describe("grantablePeople", () => {
  const member = (principalId: string, status: MemberView["status"]): MemberView => ({
    principalId: Schema.decodeSync(PublicId)(principalId),
    role: "member",
    status,
  });

  test("offers active members who hold no active grant", () => {
    const people = [
      member("01K00000000000000000000011", "active"),
      member("01K00000000000000000000012", "removed"),
      member("01K00000000000000000000013", "invited"),
      member("01K0000000000000000000000F", "active"),
      member("01K00000000000000000000014", "active"),
    ];
    const revoked = grant(
      "01K00000000000000000000003",
      "reader",
      { principalId: "01K00000000000000000000014", type: "principal" },
      "revoked",
    );
    expect(
      grantablePeople(people, [owner("01K00000000000000000000001"), revoked]).map(
        ({ principalId }) => String(principalId),
      ),
    ).toEqual(["01K00000000000000000000011", "01K00000000000000000000014"]);
  });
});
