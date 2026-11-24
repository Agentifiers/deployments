import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  AgentEmailConflictError,
  AgentEmailValidationError,
  agentEmailAddress,
  agentEmailCursor,
  agentEmailForwardSubject,
  agentEmailReplyRecipients,
  agentEmailReplySubject,
  makeAgentEmailService,
  normalizeAgentEmailDomain,
  normalizeAgentEmailLocalPart,
  parseAgentEmailCursor,
} from "./service.ts";
import {
  CreateAgentEmailPlacementRequest,
  UpdateAgentEmailDraftRequest,
  UpdateAgentEmailPolicyRequest,
} from "./contracts.ts";
import type { AgentEmailDomainRecord, AgentEmailInboxRecord, AgentEmailPage } from "./models.ts";

const domain: AgentEmailDomainRecord = {
  createdAt: "2026-07-17T00:00:00.000Z",
  dnsRecords: [],
  domain: "inboxes.example",
  id: "domain_1",
  mailFromDomain: "bounce.inboxes.example",
  organizationId: "org_1",
  providerManaged: true,
  providerMetadata: {},
  status: "verified",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

describe("agent email core", () => {
  it("rejects placements with duplicate primary and secondary regions", () => {
    expect(
      () =>
        new CreateAgentEmailPlacementRequest({
          name: "Duplicate",
          region: "us-east-1",
          secondaryRegion: " US-EAST-1 ",
        }),
    ).toThrow("secondaryRegion must differ from region");
  });

  it("normalizes placement regions and rejects empty region values", () => {
    expect(
      new CreateAgentEmailPlacementRequest({
        name: "Normalized",
        region: " US-EAST-1 ",
        secondaryRegion: " US-WEST-2 ",
      }),
    ).toMatchObject({ region: "us-east-1", secondaryRegion: "us-west-2" });
    expect(
      () =>
        new CreateAgentEmailPlacementRequest({
          name: "Empty primary",
          region: " ",
        }),
    ).toThrow("Expected a normalized AWS region");
    expect(
      () =>
        new CreateAgentEmailPlacementRequest({
          name: "Empty secondary",
          region: "us-east-1",
          secondaryRegion: " ",
        }),
    ).toThrow("Expected a normalized AWS region");
  });

  it("enforces placement region invariants during schema decoding", () => {
    expect(
      Schema.decodeUnknownSync(CreateAgentEmailPlacementRequest)({
        name: "Normalized",
        region: " US-EAST-1 ",
        secondaryRegion: " US-WEST-2 ",
      }),
    ).toMatchObject({ region: "us-east-1", secondaryRegion: "us-west-2" });
    expect(() =>
      Schema.decodeUnknownSync(CreateAgentEmailPlacementRequest)({
        name: "Duplicate",
        region: "us-east-1",
        secondaryRegion: " US-EAST-1 ",
      }),
    ).toThrow("secondaryRegion must differ from region");
  });

  it("rejects recipient-less send and forward requests", async () => {
    const { SendAgentEmailMessageRequest, AgentEmailForwardRequest } =
      await import("./contracts.ts");
    expect(() => new SendAgentEmailMessageRequest({ subject: "No recipient", to: [] })).toThrow();
    expect(() => new AgentEmailForwardRequest({ to: [] })).toThrow();
  });

  it("bounds outbound attachment counts to the persistence transaction limit", async () => {
    const {
      AgentEmailAttachmentInput,
      AgentEmailForwardRequest,
      AgentEmailReplyRequest,
      MAX_AGENT_EMAIL_ATTACHMENTS,
      SendAgentEmailMessageRequest,
    } = await import("./contracts.ts");
    const attachment = new AgentEmailAttachmentInput({
      contentBase64: "",
      contentType: "text/plain",
      fileName: "attachment.txt",
    });
    const maximum = Array.from({ length: MAX_AGENT_EMAIL_ATTACHMENTS }, () => attachment);
    const tooMany = [...maximum, attachment];

    expect(
      () =>
        new SendAgentEmailMessageRequest({
          attachments: maximum,
          subject: "Hi",
          to: ["to@example.com"],
        }),
    ).not.toThrow();

    expect(
      () =>
        new SendAgentEmailMessageRequest({
          attachments: tooMany,
          subject: "Hi",
          to: ["to@example.com"],
        }),
    ).toThrow();
    expect(() => new AgentEmailReplyRequest({ attachments: tooMany })).toThrow();
    expect(
      () =>
        new AgentEmailForwardRequest({
          attachments: tooMany,
          to: ["to@example.com"],
        }),
    ).toThrow();
    expect(
      () =>
        new SendAgentEmailMessageRequest({
          attachments: [
            {
              contentBase64: "",
              contentId: "x".repeat(79),
              contentType: "text/plain",
              fileName: "attachment.txt",
            },
          ],
          subject: "Hi",
          to: ["to@example.com"],
        }),
    ).toThrow();
  });

  it("rejects invalid policy numeric ranges", () => {
    for (const input of [
      { bounceRateThresholdBasisPoints: 10_001 },
      { complaintRateThresholdBasisPoints: -1 },
      { dailyOutboundMessageLimit: 1.5 },
      { maxAttachmentBytes: 4 * 1024 * 1024 + 1 },
      { maxRecipientsPerMessage: 0 },
      { maxRecipientsPerMessage: 48 },
      { rawRetentionDays: 0 },
      { rawRetentionDays: 366 },
    ]) {
      expect(() => new UpdateAgentEmailPolicyRequest(input)).toThrow();
    }
    expect(
      new UpdateAgentEmailPolicyRequest({
        bounceRateThresholdBasisPoints: 10_000,
        complaintRateThresholdBasisPoints: 0,
        dailyOutboundMessageLimit: 0,
        maxAttachmentBytes: 4 * 1024 * 1024,
        maxRecipientsPerMessage: 47,
        rawRetentionDays: 365,
      }),
    ).toMatchObject({ maxRecipientsPerMessage: 47, rawRetentionDays: 365 });
  });

  it("keeps provider state out of organization updates and allows warmup transitions", () => {
    expect(
      Schema.decodeUnknownSync(UpdateAgentEmailDraftRequest)({
        status: "approved",
        subject: "Editable content",
      }),
    ).toEqual({ subject: "Editable content" });
    expect(
      Schema.decodeUnknownSync(UpdateAgentEmailPolicyRequest)({
        dailyOutboundMessageLimit: 250,
        sendingStatus: "active",
        warmupStage: "production",
      }),
    ).toEqual({
      dailyOutboundMessageLimit: 250,
      sendingStatus: "active",
      warmupStage: "production",
    });
  });

  it("builds stable reply and forward subjects", () => {
    expect(agentEmailReplySubject("Re: Fwd: Quarterly update")).toBe("Re: Quarterly update");
    expect(agentEmailForwardSubject("RE: Quarterly update")).toBe("Fwd: Quarterly update");
  });

  it("deduplicates reply-all recipients and excludes the inbox", () => {
    expect(
      agentEmailReplyRecipients(
        {
          attachments: [],
          bccAddresses: [],
          ccAddresses: ["copy@example.com", "agent@inboxes.example"],
          createdAt: "2026-07-18T00:00:00.000Z",
          direction: "inbound",
          fromAddress: "sender@example.com",
          id: "emailmsg_1",
          inboxId: "inbox_1",
          organizationId: "org_1",
          references: [],
          replyToAddresses: ["reply@example.com"],
          reprocessCount: 0,
          status: "received",
          subject: "Subject",
          textBody: "Body",
          threadKey: "thread_1",
          toAddresses: ["agent@inboxes.example", "reply@example.com"],
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        "agent@inboxes.example",
        true,
      ),
    ).toEqual(["reply@example.com", "copy@example.com"]);
  });

  it("replies to outbound recipients instead of the outbound Reply-To address", () => {
    expect(
      agentEmailReplyRecipients(
        {
          attachments: [],
          bccAddresses: [],
          ccAddresses: ["copy@example.com"],
          createdAt: "2026-07-18T00:00:00.000Z",
          direction: "outbound",
          fromAddress: "agent@inboxes.example",
          id: "emailmsg_1",
          inboxId: "inbox_1",
          organizationId: "org_1",
          references: [],
          replyToAddresses: ["alternate-sender@example.com"],
          reprocessCount: 0,
          status: "delivered",
          subject: "Subject",
          textBody: "Body",
          threadKey: "thread_1",
          toAddresses: ["recipient@example.com"],
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        "agent@inboxes.example",
        false,
      ),
    ).toEqual(["recipient@example.com"]);
  });

  it("normalizes domains, local parts, and addresses", () => {
    expect(normalizeAgentEmailDomain(" Inboxes.Example. ")).toBe("inboxes.example");
    expect(normalizeAgentEmailDomain(" BÜCHER.Example. ")).toBe("xn--bcher-kva.example");
    expect(normalizeAgentEmailDomain("例子.测试")).toBe("xn--fsqu00a.xn--0zwm56d");
    expect(() => normalizeAgentEmailDomain("example.com/path")).toThrow();
    expect(() => normalizeAgentEmailDomain("example%2ecom")).toThrow();
    expect(normalizeAgentEmailLocalPart(" Billing.Bot ")).toBe("billing.bot");
    expect(agentEmailAddress("Billing.Bot", "Inboxes.Example")).toBe("billing.bot@inboxes.example");
  });

  it("rejects local parts with consecutive dots", () => {
    expect(() => normalizeAgentEmailLocalPart("billing..bot")).toThrow(AgentEmailValidationError);
  });

  it("round trips stable pagination cursors", () => {
    const cursor = agentEmailCursor("2026-07-17T00:00:00.000Z", "message_1");
    expect(parseAgentEmailCursor(cursor)).toEqual({
      createdAt: "2026-07-17T00:00:00.000Z",
      id: "message_1",
    });
  });

  it("creates custom domains with an organization-specific ownership challenge", async () => {
    const domains: AgentEmailDomainRecord[] = [];
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createDomainVerificationToken: () => "claim_token_1",
      createInboxId: () => "inbox_1",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => {
          domains.push(record);
          return record;
        },
        get: async (_organizationId, domainId) => domains.find((row) => row.id === domainId),
        list: async () => ({ items: domains }),
        update: async (record) => record,
        withLock: async () => undefined,
      },
      generateLocalPart: () => "generated",
      inboxes: {
        create: async (record) => record,
        findByAddress: async () => undefined,
        get: async () => undefined,
        list: async () => ({ items: [] }),
        update: async (record) => record,
      },
    });

    expect(service.createDomain("org_1", { domain: "Customer.Example" })).resolves.toMatchObject({
      dnsRecords: [
        {
          name: "_agent-email.customer.example",
          type: "TXT",
          value: "agent-email-verification=claim_token_1",
        },
      ],
      status: "pending",
    });
  });

  it("rejects custom domains that cannot fit a maximum-length DKIM selector", async () => {
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createInboxId: () => "inbox_1",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => record,
        get: async () => undefined,
        list: async () => ({ items: [] }),
        update: async (record) => record,
        withLock: async () => undefined,
      },
      generateLocalPart: () => "generated",
      inboxes: {
        create: async (record) => record,
        findByAddress: async () => undefined,
        get: async () => undefined,
        list: async () => ({ items: [] }),
        update: async (record) => record,
      },
    });
    const oversizedDomain = ["a".repeat(63), "b".repeat(63), "c".repeat(51)].join(".");

    expect(service.createDomain("org_1", { domain: oversizedDomain })).rejects.toBeInstanceOf(
      AgentEmailValidationError,
    );
  });

  it("creates verified-domain inboxes without platform agent concepts", async () => {
    const inboxes: AgentEmailInboxRecord[] = [];
    const inboxStore = {
      create: async (record: AgentEmailInboxRecord) => {
        inboxes.push(record);
        return record;
      },
      findByAddress: async () => undefined,
      get: async (_organizationId: string, inboxId: string) =>
        inboxes.find((row) => row.id === inboxId),
      list: async () => ({ items: inboxes }),
      update: async (record: AgentEmailInboxRecord) => record,
    };
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createInboxId: () => "inbox_1",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => record,
        get: async () => domain,
        list: async () =>
          ({
            items: [domain],
          }) satisfies AgentEmailPage<AgentEmailDomainRecord>,
        update: async (record) => record,
        withLock: async (_organizationId, _domainId, operation) => operation(domain, inboxStore),
      },
      generateLocalPart: () => "generated",
      inboxes: inboxStore,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(
      service.createInbox("org_1", {
        clientId: "app_1",
        localPart: "support.bot",
        metadata: { team: "support" },
        name: "Support",
      }),
    ).resolves.toMatchObject({
      address: "support.bot@inboxes.example",
      clientId: "app_1",
      id: "inbox_1",
      metadata: { team: "support" },
      organizationId: "org_1",
    });
  });

  it("resolves the hosted domain within the requesting organization", async () => {
    const domains = new Map(
      ["org_1", "org_2"].map((organizationId, index) => [
        organizationId,
        {
          ...domain,
          domain: `agents-${index + 1}.example.com`,
          id: `domain_${index + 1}`,
          mailFromDomain: `bounce.agents-${index + 1}.example.com`,
          organizationId,
        },
      ]),
    );
    const created: AgentEmailInboxRecord[] = [];
    let inboxSequence = 0;
    const inboxStore = {
      create: async (record: AgentEmailInboxRecord) => {
        created.push(record);
        return record;
      },
      findByAddress: async () => undefined,
      get: async () => undefined,
      list: async () => ({ items: created }),
      update: async (record: AgentEmailInboxRecord) => record,
    };
    const service = makeAgentEmailService({
      createDomainId: () => "domain_new",
      createInboxId: () => `inbox_${++inboxSequence}`,
      defaultDomain: async (organizationId) => domains.get(organizationId)!,
      domains: {
        create: async (record) => record,
        get: async (organizationId, domainId) =>
          [...domains.values()].find(
            (row) => row.organizationId === organizationId && row.id === domainId,
          ),
        list: async () => ({ items: [...domains.values()] }),
        update: async (record) => record,
        withLock: async (organizationId, domainId, operation) => {
          const selected = domains.get(organizationId);
          return selected?.id === domainId ? operation(selected, inboxStore) : undefined;
        },
      },
      generateLocalPart: () => "generated",
      inboxes: inboxStore,
    });

    await service.createInbox("org_1", { localPart: "first" });
    await service.createInbox("org_2", { localPart: "second" });

    expect(created.map((inbox) => inbox.address)).toEqual([
      "first@agents-1.example.com",
      "second@agents-2.example.com",
    ]);
  });

  it("rejects duplicate inbox addresses before insertion", async () => {
    const existingInbox: AgentEmailInboxRecord = {
      address: "support@inboxes.example",
      createdAt: "2026-07-17T00:00:00.000Z",
      domainId: domain.id,
      id: "inbox_1",
      localPart: "support",
      metadata: {},
      organizationId: "org_1",
      status: "active",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const inboxStore = {
      create: async (record: AgentEmailInboxRecord) => record,
      findByAddress: async () => existingInbox,
      get: async () => undefined,
      list: async () => ({ items: [] }),
      update: async (record: AgentEmailInboxRecord) => record,
    };
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createInboxId: () => "inbox_2",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => record,
        get: async () => domain,
        list: async () => ({ items: [domain] }),
        update: async (record) => record,
        withLock: async (_organizationId, _domainId, operation) => operation(domain, inboxStore),
      },
      generateLocalPart: () => "generated",
      inboxes: inboxStore,
    });

    expect(service.createInbox("org_1", { localPart: "support" })).rejects.toBeInstanceOf(
      AgentEmailConflictError,
    );
  });

  it("revalidates the domain under its lifecycle lock before creating an inbox", async () => {
    let createCalls = 0;
    const inboxStore = {
      create: async (record: AgentEmailInboxRecord) => {
        createCalls += 1;
        return record;
      },
      findByAddress: async () => undefined,
      get: async () => undefined,
      list: async () => ({ items: [] }),
      update: async (record: AgentEmailInboxRecord) => record,
    };
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createInboxId: () => "inbox_2",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => record,
        get: async () => domain,
        list: async () => ({ items: [domain] }),
        update: async (record) => record,
        withLock: async (_organizationId, _domainId, operation) =>
          operation({ ...domain, status: "revoked" }, inboxStore),
      },
      generateLocalPart: () => "generated",
      inboxes: inboxStore,
    });

    expect(service.createInbox("org_1", { localPart: "support" })).rejects.toBeInstanceOf(
      AgentEmailConflictError,
    );
    expect(createCalls).toBe(0);
  });

  it("revalidates activation under the domain lifecycle lock", async () => {
    const inbox: AgentEmailInboxRecord = {
      address: "support@inboxes.example",
      createdAt: "2026-07-17T00:00:00.000Z",
      domainId: domain.id,
      id: "inbox_1",
      localPart: "support",
      metadata: {},
      organizationId: "org_1",
      status: "archived",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    let updateCalls = 0;
    const inboxStore = {
      create: async (record: AgentEmailInboxRecord) => record,
      findByAddress: async () => undefined,
      get: async () => inbox,
      list: async () => ({ items: [inbox] }),
      update: async (record: AgentEmailInboxRecord) => {
        updateCalls += 1;
        return record;
      },
    };
    const service = makeAgentEmailService({
      createDomainId: () => "domain_2",
      createInboxId: () => "inbox_2",
      defaultDomain: async () => domain,
      domains: {
        create: async (record) => record,
        get: async () => domain,
        list: async () => ({ items: [domain] }),
        update: async (record) => record,
        withLock: async (_organizationId, _domainId, operation) =>
          operation({ ...domain, status: "revoked" }, inboxStore),
      },
      generateLocalPart: () => "generated",
      inboxes: inboxStore,
    });

    expect(service.updateInbox("org_1", inbox.id, { status: "active" })).rejects.toBeInstanceOf(
      AgentEmailConflictError,
    );
    expect(updateCalls).toBe(0);
  });
});
