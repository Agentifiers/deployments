import {
  AgentEmailDomainResponse,
  AgentEmailPlacementResponse,
  AgentEmailPolicyResponse,
} from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  canRevokeDomain,
  readPlacementDraft,
  sendingReadiness,
  type AgentEmailDomain,
  type AgentEmailPlacement,
  type DomainStatus,
  type PolicyState,
} from "./setup-state.ts";

const ORGANIZATION = "01J9ZQ4V6X8Y2K3M5N7P9R1T30";
const AT = "2026-10-01T12:00:00.000Z";

function domain(status: DomainStatus, providerManaged = false): AgentEmailDomain {
  return Schema.decodeUnknownSync(AgentEmailDomainResponse)({
    createdAt: AT,
    dnsRecords: [],
    domain: "mail.example.com",
    id: "01J9ZQ4V6X8Y2K3M5N7P9R1TD1",
    mailFromDomain: "bounce.mail.example.com",
    organizationId: ORGANIZATION,
    providerManaged,
    providerMetadata: {},
    status,
    updatedAt: AT,
  });
}

function placement(
  isDefault: boolean,
  status: AgentEmailPlacement["status"] = "active",
): AgentEmailPlacement {
  return Schema.decodeUnknownSync(AgentEmailPlacementResponse)({
    createdAt: AT,
    dedicatedPool: false,
    id: "01J9ZQ4V6X8Y2K3M5N7P9R1TP1",
    isDefault,
    name: "Primary",
    organizationId: ORGANIZATION,
    provider: "ses",
    providerMetadata: {},
    region: "us-east-2",
    status,
    updatedAt: AT,
  });
}

function savedPolicy(sendingStatus: "active" | "paused" | "suspended"): PolicyState {
  return {
    kind: "saved",
    policy: Schema.decodeUnknownSync(AgentEmailPolicyResponse)({
      bounceRateThresholdBasisPoints: 500,
      complaintRateThresholdBasisPoints: 10,
      createdAt: AT,
      dailyOutboundMessageLimit: 1000,
      id: "01J9ZQ4V6X8Y2K3M5N7P9R1TQ1",
      maxAttachmentBytes: 4_194_304,
      maxRecipientsPerMessage: 47,
      organizationId: ORGANIZATION,
      rawRetentionDays: 30,
      sendingStatus,
      updatedAt: AT,
      warmupStage: "sandbox",
    }),
  };
}

const DEFAULTS: PolicyState = { kind: "defaults" };

describe("sendingReadiness", () => {
  test("lists domain, placement, then policy, the order the platform checks before a send", () => {
    const checks = sendingReadiness({
      domains: [domain("verified")],
      placements: [placement(true)],
      policy: DEFAULTS,
    });
    expect(checks.map((check) => check.step)).toEqual(["domain", "placement", "policy"]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  test("a fresh environment has no domain and no placement yet", () => {
    expect(sendingReadiness({ domains: [], placements: [], policy: DEFAULTS })).toEqual([
      { ok: false, step: "domain", total: 0, verified: 0 },
      { activeDefaults: 0, defaults: 0, ok: false, step: "placement" },
      { ok: true, policy: DEFAULTS, step: "policy" },
    ]);
  });

  test("a pending custom domain does not count, a verified hosted one does", () => {
    const [check] = sendingReadiness({
      domains: [domain("pending_dns"), domain("verified", true)],
      placements: [],
      policy: DEFAULTS,
    });
    expect(check).toEqual({ ok: true, step: "domain", total: 2, verified: 1 });
  });

  test("the placement step needs exactly one default and it must be active", () => {
    const step = (placements: readonly AgentEmailPlacement[]) =>
      sendingReadiness({ domains: [], placements, policy: DEFAULTS })[1];
    expect(step([placement(false)])).toEqual({
      activeDefaults: 0,
      defaults: 0,
      ok: false,
      step: "placement",
    });
    expect(step([placement(true, "provisioning")])).toEqual({
      activeDefaults: 0,
      defaults: 1,
      ok: false,
      step: "placement",
    });
    expect(step([placement(true), placement(true, "disabled")])).toEqual({
      activeDefaults: 1,
      defaults: 2,
      ok: false,
      step: "placement",
    });
    expect(step([placement(true), placement(false)])).toEqual({
      activeDefaults: 1,
      defaults: 1,
      ok: true,
      step: "placement",
    });
  });

  test("an unsaved policy sends under the defaults; a paused or suspended one blocks", () => {
    const ok = (policy: PolicyState) =>
      sendingReadiness({ domains: [], placements: [], policy })[2].ok;
    expect(ok(DEFAULTS)).toBe(true);
    expect(ok(savedPolicy("active"))).toBe(true);
    expect(ok(savedPolicy("paused"))).toBe(false);
    expect(ok(savedPolicy("suspended"))).toBe(false);
  });
});

describe("canRevokeDomain", () => {
  test("only an unrevoked custom domain can be revoked", () => {
    expect(canRevokeDomain(domain("verified"))).toBe(true);
    expect(canRevokeDomain(domain("pending"))).toBe(true);
    expect(canRevokeDomain(domain("revoked"))).toBe(false);
    expect(canRevokeDomain(domain("verified", true))).toBe(false);
  });
});

describe("readPlacementDraft", () => {
  const draft = { isDefault: true, name: " Primary ", region: "us-east-2", secondaryRegion: "" };

  test("builds a body without a dedicated pool", () => {
    expect(readPlacementDraft(draft)).toEqual({
      body: { isDefault: true, name: "Primary", region: "us-east-2" },
      ok: true,
    });
    expect(
      readPlacementDraft({ ...draft, isDefault: false, secondaryRegion: "us-west-2" }),
    ).toEqual({
      body: {
        isDefault: false,
        name: "Primary",
        region: "us-east-2",
        secondaryRegion: "us-west-2",
      },
      ok: true,
    });
  });

  test("refuses what the platform refuses", () => {
    expect(readPlacementDraft({ ...draft, name: "  " })).toEqual({
      message: "Name the placement in 1 to 120 characters.",
      ok: false,
    });
    expect(readPlacementDraft({ ...draft, region: "Ohio" })).toEqual({
      message: "Enter an AWS region, such as us-east-2.",
      ok: false,
    });
    expect(
      readPlacementDraft({ ...draft, isDefault: false, secondaryRegion: "us-east-2" }),
    ).toEqual({ message: "The secondary region must differ from the region.", ok: false });
    expect(readPlacementDraft({ ...draft, secondaryRegion: "us-west-2" })).toEqual({
      message: "A default placement cannot have a secondary region.",
      ok: false,
    });
  });
});
