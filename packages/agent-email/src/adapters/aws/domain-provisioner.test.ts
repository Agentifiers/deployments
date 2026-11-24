import { describe, expect, it } from "bun:test";
import type { AgentEmailDomainRecord, AgentEmailPlacementRecord } from "../../core/index.ts";
import {
  agentEmailSesDkimDomain,
  makeAgentEmailSesDomainProvisioner,
  type AgentEmailSesDomainOperations,
} from "./domain-provisioner.ts";

const domain: AgentEmailDomainRecord = {
  createdAt: "2026-07-20T00:00:00.000Z",
  dnsRecords: [
    {
      name: "_agent-email.customer.example",
      type: "TXT",
      value: "agent-email-verification=customer-token",
    },
  ],
  domain: "customer.example",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mailFromDomain: "bounce.customer.example",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  placementId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  providerManaged: false,
  providerMetadata: {},
  status: "pending_dns",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const placement: AgentEmailPlacementRecord = {
  createdAt: "2026-07-20T00:00:00.000Z",
  dedicatedPool: false,
  id: domain.placementId!,
  isDefault: false,
  name: "Resilient US",
  organizationId: domain.organizationId,
  provider: "ses",
  providerMetadata: { configurationSetName: "agent-inboxes-placement" },
  region: "us-east-2",
  secondaryRegion: "us-west-2",
  status: "active",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

function operationsFixture(
  options: { readonly failCreateIn?: string; readonly secondaryMailFromDomain?: string } = {},
) {
  const calls: { readonly input?: unknown; readonly operation: string; readonly region: string }[] =
    [];
  const operationsForRegion = (region: string): AgentEmailSesDomainOperations => ({
    associateTenantResource: async (tenantName, resourceArn) => {
      calls.push({ input: { resourceArn, tenantName }, operation: "associate", region });
    },
    createIdentity: async (input) => {
      calls.push({ input, operation: "createIdentity", region });
      if (options.failCreateIn === region) throw new Error("replica failed");
    },
    deleteIdentity: async (identity) => {
      calls.push({ input: identity, operation: "deleteIdentity", region });
    },
    dissociateTenantResource: async (tenantName, resourceArn) => {
      calls.push({ input: { resourceArn, tenantName }, operation: "dissociate", region });
    },
    getIdentity: async () => {
      calls.push({ operation: "getIdentity", region });
      return region === placement.region
        ? {
            $metadata: {},
            DkimAttributes: { Status: "SUCCESS", Tokens: ["shared-dkim"] },
            MailFromAttributes: {
              BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
              MailFromDomain: domain.mailFromDomain,
              MailFromDomainStatus: "SUCCESS",
            },
            VerificationStatus: "SUCCESS",
            VerifiedForSendingStatus: true,
          }
        : {
            $metadata: {},
            DkimAttributes: { Status: "SUCCESS", Tokens: [] },
            MailFromAttributes: {
              BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
              MailFromDomain: options.secondaryMailFromDomain ?? "b-d8c0d063.customer.example",
              MailFromDomainStatus: "SUCCESS",
            },
            VerificationStatus: "SUCCESS",
            VerifiedForSendingStatus: true,
          };
    },
    listTags: async (resourceArn) => {
      calls.push({ input: resourceArn, operation: "listTags", region });
      return [
        { Key: "agent-inboxes:organization-id", Value: domain.organizationId },
        { Key: "agent-inboxes:resource-id", Value: domain.id },
      ];
    },
    putMailFrom: async (identity, mailFromDomain) => {
      calls.push({ input: { identity, mailFromDomain }, operation: "putMailFrom", region });
    },
  });
  return { calls, operationsForRegion };
}

function provisioner(
  fixture: ReturnType<typeof operationsFixture>,
  resolvedPlacement: AgentEmailPlacementRecord = placement,
  mxRecords: readonly { exchange: string; priority: number }[] = [
    { exchange: "inbound-smtp.us-east-2.amazonaws.com", priority: 10 },
  ],
) {
  return makeAgentEmailSesDomainProvisioner({
    accountId: "123456789012",
    defaultRegion: placement.region,
    getPlacement: async () => resolvedPlacement,
    inboundReady: async () => true,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    operationsForRegion: fixture.operationsForRegion,
    resolveTxt: async () => [["agent-email-verification=customer-token"]],
    resolveMx: async () => mxRecords,
  });
}

describe("agent email SES domain provisioning", () => {
  it("verifies send-only DNS without taking over existing inbound delivery", async () => {
    const fixture = operationsFixture();
    const adapter = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      mode: "send-only",
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      inboundReady: async () => {
        throw new Error("Receiving must not be consulted");
      },
      resolveMx: async () => {
        throw new Error("Apex MX must not be consulted");
      },
    });
    const result = await adapter.provision(domain);
    expect(result.status).toBe("verified");
    expect(
      result.dnsRecords.some((record) => record.type === "MX" && record.name === domain.domain),
    ).toBe(false);
    expect(result.dnsRecords).toContainEqual({
      name: domain.mailFromDomain,
      type: "MX",
      priority: 10,
      value: "feedback-smtp.us-east-2.amazonses.com",
    });
    expect((await adapter.refresh(result)).status).toBe("verified");
  });

  it("keeps receiving DNS instructions by default", async () => {
    const result = await provisioner(operationsFixture()).provision(domain);
    expect(result.dnsRecords).toContainEqual({
      name: domain.domain,
      type: "MX",
      priority: 10,
      value: "inbound-smtp.us-east-2.amazonaws.com",
    });
  });

  it("returns an actionable ownership challenge without touching SES", async () => {
    const fixture = operationsFixture();
    const adapter = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      mode: "send-only",
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [],
    });
    for (const operation of [adapter.provision, adapter.refresh]) {
      const result = await operation(domain);
      expect(result.status).toBe("pending_dns");
      expect(result.dnsRecords).toEqual(domain.dnsRecords);
      expect(result.failureReason).toBeDefined();
    }
    expect(fixture.calls).toEqual([]);
  });

  it("refuses shared identities and never mutates or cleans them", async () => {
    const fixture = operationsFixture();
    const adapter = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      mode: "send-only",
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      operationsForRegion: (region) => ({
        ...fixture.operationsForRegion(region),
        createIdentity: async () => {
          throw Object.assign(new Error(), { name: "AlreadyExistsException" });
        },
        listTags: async () => [{ Key: "agent-inboxes:resource-id", Value: "foreign" }],
      }),
    });
    expect(adapter.provision(domain)).rejects.toMatchObject({
      name: "AgentEmailDomainIdentityOwnershipError",
    });
    expect(adapter.refresh(domain)).rejects.toMatchObject({
      name: "AgentEmailDomainIdentityOwnershipError",
    });
    expect((await adapter.revoke({ ...domain, status: "revoked" })).status).toBe("revoked");
    expect(fixture.calls).toEqual([]);
  });

  it("allows cleanup retries after send-only revocation is persisted", async () => {
    const fixture = operationsFixture();
    const adapter = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      mode: "send-only",
      operationsForRegion: fixture.operationsForRegion,
    });
    expect((await adapter.revoke({ ...domain, status: "revoked" })).status).toBe("revoked");
    expect(
      fixture.calls
        .filter((call) => call.operation === "deleteIdentity")
        .map((call) => call.region),
    ).toEqual(["us-west-2", "us-east-2"]);
    expect(adapter.provision({ ...domain, status: "revoked" })).rejects.toThrow();
  });

  it("does not clean up a created identity whose ownership has changed", async () => {
    const fixture = operationsFixture({ failCreateIn: "us-west-2" });
    const adapter = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      mode: "send-only",
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      operationsForRegion: (region) => ({
        ...fixture.operationsForRegion(region),
        listTags: async () => [],
      }),
    });
    expect(adapter.provision(domain)).rejects.toBeInstanceOf(AggregateError);
    expect(
      fixture.calls.filter((call) => ["deleteIdentity", "dissociate"].includes(call.operation)),
    ).toEqual([]);
  });

  it("uses regional SES DKIM signing zones when required", () => {
    expect(agentEmailSesDkimDomain("me-central-1")).toBe("dkim.me-central-1.amazonses.com");
    expect(agentEmailSesDkimDomain("eu-south-1")).toBe("dkim.eu-south-1.amazonses.com");
    expect(agentEmailSesDkimDomain("il-central-1")).toBe("dkim.il-central-1.amazonses.com");
    expect(agentEmailSesDkimDomain("ap-northeast-3")).toBe("dkim.ap-northeast-3.amazonses.com");
    expect(agentEmailSesDkimDomain("me-south-1")).toBe("dkim.amazonses.com");
    expect(agentEmailSesDkimDomain("us-east-1")).toBe("dkim.amazonses.com");
    expect(agentEmailSesDkimDomain("us-east-1", "custom.signing.example.")).toBe(
      "custom.signing.example",
    );
  });

  it("uses the configured AWS partition for identity ownership checks", async () => {
    const fixture = operationsFixture();
    const { placementId: _placementId, ...unplacedDomain } = domain;
    const govProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: "us-gov-east-1",
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      partition: "aws-us-gov",
    });

    await govProvisioner.revoke({
      ...unplacedDomain,
      providerIdentity: domain.domain,
      status: "verified",
    });

    expect(fixture.calls.find((call) => call.operation === "listTags")?.input).toBe(
      "arn:aws-us-gov:ses:us-gov-east-1:123456789012:identity/customer.example",
    );
  });

  it("rejects custom-domain placements outside the configured inbound receipt region", async () => {
    const fixture = operationsFixture();
    const mismatchedProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: "us-east-1",
      getPlacement: async () => placement,
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
    });

    expect(mismatchedProvisioner.provision(domain)).rejects.toThrow(
      "must use inbound receipt region us-east-1",
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("creates a primary identity and deterministic-DKIM secondary replica", async () => {
    const fixture = operationsFixture();
    const result = await provisioner(fixture).provision(domain);

    expect(result).toMatchObject({
      providerMetadata: { inboundRegion: "us-east-2", multiRegionOutbound: true },
      status: "verified",
      verifiedAt: "2026-07-20T12:00:00.000Z",
    });
    const creates = fixture.calls.filter((call) => call.operation === "createIdentity");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      input: {
        ConfigurationSetName: "agent-inboxes-placement",
        EmailIdentity: domain.domain,
      },
      region: "us-east-2",
    });
    expect(creates[1]).toMatchObject({
      input: {
        DkimSigningAttributes: { DomainSigningAttributesOrigin: "AWS_SES_US_EAST_2" },
      },
      region: "us-west-2",
    });
    expect(fixture.calls.filter((call) => call.operation === "associate")).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.operation === "putMailFrom")).toEqual([
      expect.objectContaining({
        input: { identity: domain.domain, mailFromDomain: domain.mailFromDomain },
        region: "us-east-2",
      }),
      expect.objectContaining({
        input: {
          identity: domain.domain,
          mailFromDomain: "b-d8c0d063.customer.example",
        },
        region: "us-west-2",
      }),
    ]);
    expect(result.dnsRecords).toContainEqual({
      name: "b-d8c0d063.customer.example",
      priority: 10,
      type: "MX",
      value: "feedback-smtp.us-west-2.amazonses.com",
    });
    expect(result.dnsRecords).toContainEqual(domain.dnsRecords[0]!);
  });

  it("keeps domains pending when another MX route outranks SES", async () => {
    const fixture = operationsFixture();
    const result = await provisioner(fixture, placement, [
      { exchange: "mail.customer.example", priority: 5 },
      { exchange: "inbound-smtp.us-east-2.amazonaws.com", priority: 10 },
    ]).provision(domain);

    expect(result.status).toBe("pending_dns");
    expect(result.verifiedAt).toBeUndefined();
  });

  it("keeps domains pending when the inbound MX record does not exist", async () => {
    const fixture = operationsFixture();
    const missingMxProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      inboundReady: async () => true,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      resolveMx: async () => {
        throw Object.assign(new Error("no MX data"), { code: "ENODATA" });
      },
    });

    expect(missingMxProvisioner.refresh(domain)).resolves.toMatchObject({
      status: "pending_dns",
    });
  });

  it("propagates transient inbound MX resolver failures", async () => {
    const fixture = operationsFixture();
    const resolverFailure = Object.assign(new Error("DNS server failure"), { code: "ESERVFAIL" });
    const failingProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      inboundReady: async () => true,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      resolveMx: async () => {
        throw resolverFailure;
      },
    });

    expect(
      failingProvisioner.refresh({
        ...domain,
        providerIdentity: domain.domain,
        status: "verified",
        verifiedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).rejects.toBe(resolverFailure);
  });

  it("preserves newly provisioned identities when inbound MX resolution fails", async () => {
    const fixture = operationsFixture();
    const resolverFailure = Object.assign(new Error("DNS server failure"), { code: "ESERVFAIL" });
    const failingProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      inboundReady: async () => true,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
      resolveMx: async () => {
        throw resolverFailure;
      },
    });

    expect(failingProvisioner.provision(domain)).rejects.toBe(resolverFailure);
    expect(fixture.calls.filter((call) => call.operation === "deleteIdentity")).toEqual([]);
  });

  it("preserves newly provisioned identities when inbound readiness checks fail", async () => {
    const fixture = operationsFixture();
    const readinessFailure = new Error("inbound worker unavailable");
    const failingProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      getPlacement: async () => placement,
      inboundReady: async () => {
        throw readinessFailure;
      },
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=customer-token"]],
    });

    expect(failingProvisioner.provision(domain)).rejects.toBe(readinessFailure);
    expect(fixture.calls.filter((call) => call.operation === "deleteIdentity")).toEqual([]);
  });

  it("reads but never mutates the OpenTofu-managed hosted identity", async () => {
    const fixture = operationsFixture();
    const { placementId: _placementId, ...unplacedDomain } = domain;
    const hostedDomain = {
      ...unplacedDomain,
      dnsRecords: [],
      providerManaged: true,
      status: "verified" as const,
    };
    const hostedProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      hostedDomain: domain.domain,
      inboundReady: async () => true,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveMx: async () => [{ exchange: "inbound-smtp.us-east-2.amazonaws.com", priority: 10 }],
    });

    expect(hostedProvisioner.provision(hostedDomain)).resolves.toMatchObject({
      providerIdentity: domain.domain,
      status: "verified",
    });
    expect(hostedProvisioner.refresh(hostedDomain)).resolves.toMatchObject({
      providerIdentity: domain.domain,
      status: "verified",
    });
    expect(hostedProvisioner.revoke(hostedDomain)).rejects.toThrow(
      "OpenTofu-managed hosted email domains cannot be revoked",
    );
    expect(
      fixture.calls.filter((call) =>
        ["createIdentity", "deleteIdentity", "dissociate", "listTags", "putMailFrom"].includes(
          call.operation,
        ),
      ),
    ).toEqual([]);
  });

  it("keeps the hosted domain pending until inbound processing is ready", async () => {
    const fixture = operationsFixture();
    const { placementId: _placementId, ...unplacedDomain } = domain;
    const hostedDomain = {
      ...unplacedDomain,
      dnsRecords: [],
      providerManaged: true,
      status: "pending_dns" as const,
    };
    const hostedProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: placement.region,
      hostedDomain: domain.domain,
      inboundReady: async () => false,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      operationsForRegion: fixture.operationsForRegion,
      resolveMx: async () => [{ exchange: "inbound-smtp.us-east-2.amazonaws.com", priority: 10 }],
    });

    expect(hostedProvisioner.refresh(hostedDomain)).resolves.toMatchObject({
      status: "pending_dns",
    });
  });

  it("rejects provisioning before creating SES identities when ownership is unverified", async () => {
    const fixture = operationsFixture();
    const unverifiedProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: "us-east-1",
      getPlacement: async () => placement,
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => [["agent-email-verification=another-token"]],
    });

    expect(unverifiedProvisioner.provision(domain)).rejects.toThrow(
      "ownership TXT record is not verified",
    );
    expect(fixture.calls.some((call) => call.operation === "createIdentity")).toBeFalse();
  });

  it("treats a missing ownership TXT record as unverified", async () => {
    const fixture = operationsFixture();
    const missingTxtProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: "us-east-1",
      getPlacement: async () => placement,
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => {
        throw Object.assign(new Error("no TXT data"), { code: "ENODATA" });
      },
    });

    expect(missingTxtProvisioner.provision(domain)).rejects.toThrow(
      "ownership TXT record is not verified",
    );
    expect(fixture.calls).toHaveLength(0);
  });

  it("propagates transient ownership TXT resolver failures", async () => {
    const fixture = operationsFixture();
    const resolverFailure = Object.assign(new Error("DNS timeout"), { code: "ETIMEOUT" });
    const failingProvisioner = makeAgentEmailSesDomainProvisioner({
      accountId: "123456789012",
      defaultRegion: "us-east-1",
      getPlacement: async () => placement,
      operationsForRegion: fixture.operationsForRegion,
      resolveTxt: async () => {
        throw resolverFailure;
      },
    });

    expect(failingProvisioner.provision(domain)).rejects.toBe(resolverFailure);
    expect(fixture.calls).toHaveLength(0);
  });

  it("preserves the first verification timestamp across successful refreshes", async () => {
    const fixture = operationsFixture();
    const result = await provisioner(fixture).refresh({
      ...domain,
      lastCheckedAt: "2026-07-20T10:00:00.000Z",
      providerIdentity: domain.domain,
      status: "verified",
      verifiedAt: "2026-07-20T10:00:00.000Z",
    });

    expect(result.lastCheckedAt).toBe("2026-07-20T12:00:00.000Z");
    expect(result.verifiedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  it("dissociates every tenant resource before deleting regional identities", async () => {
    const fixture = operationsFixture();
    const result = await provisioner(fixture).revoke({
      ...domain,
      providerIdentity: domain.domain,
      status: "verified",
    });

    expect(result).toMatchObject({ providerMetadata: {}, status: "revoked" });
    const lastDissociation = fixture.calls.findLastIndex((call) => call.operation === "dissociate");
    const firstDeletion = fixture.calls.findIndex((call) => call.operation === "deleteIdentity");
    expect(lastDissociation).toBeLessThan(firstDeletion);
    expect(
      fixture.calls
        .filter((call) => call.operation === "deleteIdentity")
        .map((call) => call.region),
    ).toEqual(["us-west-2", "us-east-2"]);
  });

  it("revokes identities after a placement has failed without configuration metadata", async () => {
    const fixture = operationsFixture();
    const result = await provisioner(fixture, {
      ...placement,
      providerMetadata: {},
      status: "failed",
    }).revoke({
      ...domain,
      providerIdentity: domain.domain,
      status: "verified",
    });

    expect(result.status).toBe("revoked");
    expect(
      fixture.calls
        .filter((call) => call.operation === "deleteIdentity")
        .map((call) => call.region),
    ).toEqual(["us-west-2", "us-east-2"]);
  });

  it("cleans up the primary identity when secondary creation fails", async () => {
    const fixture = operationsFixture({ failCreateIn: "us-west-2" });

    expect(provisioner(fixture).provision(domain)).rejects.toThrow("replica failed");
    expect(
      fixture.calls
        .filter((call) => call.operation === "deleteIdentity")
        .map((call) => call.region),
    ).toEqual(["us-east-2"]);
  });

  it("does not verify a replica with a stale regional MAIL FROM domain", async () => {
    const fixture = operationsFixture({
      secondaryMailFromDomain: domain.mailFromDomain,
    });

    const result = await provisioner(fixture).provision(domain);

    expect(result.status).toBe("failed");
    expect(result.providerMetadata).toMatchObject({
      regionalIdentities: [
        expect.anything(),
        {
          expectedMailFromDomain: "b-d8c0d063.customer.example",
          mailFromDomain: domain.mailFromDomain,
          region: "us-west-2",
        },
      ],
    });
  });
});
