import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import {
  inboxDomainRecord,
  inboxPolicyRecord,
  inboxRecord,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";
import {
  ORGANIZATION_ID,
  PROJECT_ID,
  ENVIRONMENT_ID,
  RECIPIENT_DOMAIN_ID,
  INBOX_ID,
  RECIPIENT_INBOX_ID,
  EVENT_ID,
  MESSAGE_ID,
  USAGE_ID,
  NOW,
  scope,
  domain,
  inbox,
  policy,
  database,
  invocation,
  ids,
} from "./application-service-test-support.ts";

describe("Dynamo-backed agent email application service", () => {
  it("requires verified recipients during sandbox warmup", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy()),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation({ subject: "Warmup", to: ["unverified@example.com"] }, { inboxId: INBOX_ID }),
      ),
    ).rejects.toMatchObject({ code: "recipient_not_verified", status: 409 });
  });

  it("allows an administrator-approved recipient during sandbox warmup", async () => {
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      inboxPolicyRecord(scope, policy({ allowlist: [" Approved@Example.com "] })),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation({ subject: "Warmup", to: ["approved@example.com"] }, { inboxId: INBOX_ID }),
      ),
    ).resolves.toMatchObject({
      status: "queued",
      toAddresses: ["approved@example.com"],
    });
  });

  it("allows an active inbox in the authenticated environment during sandbox warmup", async () => {
    const recipient = inboxRecord(
      scope,
      inbox({
        address: "recipient@agents.example.com",
        id: RECIPIENT_INBOX_ID,
        localPart: "recipient",
      }),
    );
    const claim = uniqueClaimRequirements(recipient)[0];
    if (!claim) throw new Error("The recipient inbox did not produce an address claim.");
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      recipient,
      makeUniqueClaimRecord(claim, NOW) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >,
      inboxPolicyRecord(scope, policy()),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          { subject: "Warmup", to: ["recipient@agents.example.com"] },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({
      status: "queued",
      toAddresses: ["recipient@agents.example.com"],
    });
  });

  it("does not count the sender inbox twice at the verified-recipient transaction boundary", async () => {
    const sender = inboxRecord(scope, inbox());
    const senderClaim = uniqueClaimRequirements(sender)[0];
    if (!senderClaim) throw new Error("The sender inbox did not produce an address claim.");
    const verifiedAddresses = Array.from(
      { length: 45 },
      (_, index) => `verified-${index}@example.com`,
    );
    const verifications = verifiedAddresses.map(
      (address, index) =>
        withCanonicalRecordKeys({
          data: {
            address,
            createdAt: NOW,
            emailHash: `email-hash-${index}`,
            environmentId: ENVIRONMENT_ID,
            id: `verification-${index}`,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            status: "verified" as const,
            tokenHash: `token-hash-${index}`,
            updatedAt: NOW,
            version: 1,
          },
          itemType: "inbox-recipient-verification" as const,
        }) as PlatformRecord,
    );
    const memory = database([
      inboxDomainRecord(scope, domain()),
      sender,
      makeUniqueClaimRecord(senderClaim, NOW) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >,
      inboxPolicyRecord(scope, policy()),
      ...verifications,
    ]);
    const service = createDynamoAgentEmailApplicationService({
      createId: ids([MESSAGE_ID, EVENT_ID, USAGE_ID]),
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          {
            subject: "Warmup boundary",
            to: [sender.data.address, ...verifiedAddresses],
          },
          { inboxId: INBOX_ID },
        ),
      ),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("does not treat an archived inbox as a verified warmup recipient", async () => {
    const recipient = inboxRecord(
      scope,
      inbox({
        address: "recipient@agents.example.com",
        id: RECIPIENT_INBOX_ID,
        localPart: "recipient",
        status: "archived",
      }),
    );
    const claim = uniqueClaimRequirements(recipient)[0];
    if (!claim) throw new Error("The recipient inbox did not produce an address claim.");
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxRecord(scope, inbox()),
      recipient,
      makeUniqueClaimRecord(claim, NOW) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >,
      inboxPolicyRecord(scope, policy()),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          { subject: "Warmup", to: ["recipient@agents.example.com"] },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "recipient_not_verified", status: 409 });
  });

  it("does not extend intrinsic warmup verification across inbox domains", async () => {
    const recipient = inboxRecord(
      scope,
      inbox({
        address: "recipient@revoked.example.com",
        domainId: RECIPIENT_DOMAIN_ID,
        id: RECIPIENT_INBOX_ID,
        localPart: "recipient",
      }),
    );
    const claim = uniqueClaimRequirements(recipient)[0];
    if (!claim) throw new Error("The recipient inbox did not produce an address claim.");
    const memory = database([
      inboxDomainRecord(scope, domain()),
      inboxDomainRecord(
        scope,
        domain({
          domain: "revoked.example.com",
          id: RECIPIENT_DOMAIN_ID,
          mailFromDomain: "bounce.revoked.example.com",
          status: "verified",
        }),
      ),
      inboxRecord(scope, inbox()),
      recipient,
      makeUniqueClaimRecord(claim, NOW) as Extract<
        PlatformRecord,
        { readonly itemType: "unique-claim" }
      >,
      inboxPolicyRecord(scope, policy()),
    ]);
    const service = createDynamoAgentEmailApplicationService({
      database: memory.service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation(
          { subject: "Warmup", to: ["recipient@revoked.example.com"] },
          { inboxId: INBOX_ID },
        ),
      ),
    ).rejects.toMatchObject({ code: "recipient_not_verified", status: 409 });
  });

  it("rejects a recipient blocked by the outbound policy", async () => {
    const service = createDynamoAgentEmailApplicationService({
      database: database([
        inboxDomainRecord(scope, domain()),
        inboxRecord(scope, inbox()),
        inboxPolicyRecord(
          scope,
          policy({
            blocklist: ["Blocked@Example.com"],
            warmupStage: "production",
          }),
        ),
      ]).service,
      now: () => new Date(NOW),
      endUserKeys: testEndUserKeys,
    });

    expect(
      service.execute(
        "sendInboxMessage",
        invocation({ subject: "Blocked", to: ["blocked@example.com"] }, { inboxId: INBOX_ID }),
      ),
    ).rejects.toMatchObject({ code: "recipient_blocked", status: 409 });
  });
});
