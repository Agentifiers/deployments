import type {
  AgentEmailDomainRecord,
  AgentEmailDraftRecord,
  AgentEmailInboxBindingRecord,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailPage,
  AgentEmailPlacementRecord,
  AgentEmailPolicyRecord,
  AgentEmailSuppressionRecord,
  AgentEmailThreadRecord,
} from "@deployments-ai/agent-email";
import type {
  AgentEmailAccessUrl,
  AgentEmailThreadDetail,
  AgentEmailUsageExport,
  AgentEmailUsageSummary,
} from "./agent-email.ts";
import type { PlatformRequest } from "./index.ts";

function mockAgentEmailDomain(
  id: string,
  organizationId: string,
  now: string,
  status: AgentEmailDomainRecord["status"] = "verified",
): AgentEmailDomainRecord {
  const domain = `${id.replaceAll(/[^a-z0-9-]+/giu, "-")}.example.com`.toLowerCase();
  return {
    createdAt: now,
    dnsRecords: [],
    domain,
    id,
    mailFromDomain: `bounce.${domain}`,
    organizationId,
    providerManaged: false,
    providerMetadata: {},
    status,
    updatedAt: now,
    ...(status === "verified" ? { verifiedAt: now } : {}),
  };
}

function mockAgentEmailInbox(
  id: string,
  organizationId: string,
  now: string,
): AgentEmailInboxRecord {
  return {
    address: `${id}@agents.example.com`,
    createdAt: now,
    domainId: "domain_mock",
    id,
    localPart: id,
    metadata: {},
    name: `Inbox ${id}`,
    organizationId,
    status: "active",
    updatedAt: now,
  };
}

function mockAgentEmailMessage(
  id: string,
  inboxId: string,
  organizationId: string,
  now: string,
  threadId = "thread_mock",
): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: now,
    direction: "outbound",
    fromAddress: `${inboxId}@agents.example.com`,
    id,
    inboxId,
    organizationId,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "delivered",
    subject: `Message ${id}`,
    textBody: "Mock agent email message.",
    threadId,
    threadKey: threadId,
    toAddresses: ["recipient@example.com"],
    updatedAt: now,
  };
}

function mockAgentEmailThread(
  id: string,
  inboxId: string,
  organizationId: string,
  now: string,
): AgentEmailThreadRecord {
  return {
    createdAt: now,
    id,
    inboxId,
    lastMessageAt: now,
    messageCount: 1,
    organizationId,
    participants: [`${inboxId}@agents.example.com`, "recipient@example.com"],
    subject: `Thread ${id}`,
    updatedAt: now,
  };
}

function mockAgentEmailDraft(
  id: string,
  inboxId: string,
  organizationId: string,
  now: string,
  status: AgentEmailDraftRecord["status"] = "draft",
): AgentEmailDraftRecord {
  return {
    bccAddresses: [],
    ccAddresses: [],
    createdAt: now,
    id,
    inboxId,
    metadata: {},
    organizationId,
    status,
    subject: `Draft ${id}`,
    textBody: "Mock agent email draft.",
    toAddresses: ["recipient@example.com"],
    updatedAt: now,
  };
}

function mockAgentEmailPlacement(
  id: string,
  organizationId: string,
  now: string,
): AgentEmailPlacementRecord {
  return {
    createdAt: now,
    dedicatedPool: false,
    id,
    isDefault: false,
    name: `Placement ${id}`,
    organizationId,
    provider: "ses",
    providerMetadata: {},
    region: "us-east-1",
    status: "active",
    updatedAt: now,
  };
}

function mockAgentEmailSuppression(
  id: string,
  organizationId: string,
  now: string,
): AgentEmailSuppressionRecord {
  return {
    address: `${id}@example.com`,
    createdAt: now,
    id,
    organizationId,
    reason: "manual",
  };
}

function mockAgentEmailBinding(
  id: string,
  inboxId: string,
  organizationId: string,
  now: string,
): AgentEmailInboxBindingRecord {
  return {
    agentDeploymentId: "deployment_mock",
    bindingType: "platform_agent",
    createdAt: now,
    externalId: "deployment_mock",
    id,
    inboxId,
    metadata: {},
    organizationId,
    status: "active",
    updatedAt: now,
  };
}

function mockAgentEmailPage<T>(factory: (suffix: string) => T): AgentEmailPage<T> {
  return { items: [factory("alpha"), factory("beta")] };
}

export function mockAgentEmailData(
  request: PlatformRequest,
  now: string,
): { readonly data?: unknown; readonly matched: boolean } {
  const prefix = "/v1/agent-email";
  if (request.path !== prefix && !request.path.startsWith(`${prefix}/`)) return { matched: false };
  const segments = request.path
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const organizationId = request.context?.organizationId ?? "org_mock";
  const [resource, id, child, childId] = segments;

  if (resource === "domains") {
    if (!id) {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailDomain(`domain_${suffix}`, organizationId, now),
              )
            : mockAgentEmailDomain("domain_mock", organizationId, now, "pending_dns"),
        matched: true,
      };
    }
    const status = child === "revoke" ? "revoked" : "verified";
    return { data: mockAgentEmailDomain(id, organizationId, now, status), matched: true };
  }

  if (resource === "inboxes") {
    if (!id) {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailInbox(`inbox_${suffix}`, organizationId, now),
              )
            : mockAgentEmailInbox("inbox_mock", organizationId, now),
        matched: true,
      };
    }
    if (!child) return { data: mockAgentEmailInbox(id, organizationId, now), matched: true };
    if (child === "bindings") {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailBinding(`binding_${suffix}`, id, organizationId, now),
              )
            : mockAgentEmailBinding("binding_mock", id, organizationId, now),
        matched: true,
      };
    }
    if (child === "messages") {
      if (!childId) {
        return {
          data:
            request.method === "GET"
              ? mockAgentEmailPage((suffix) =>
                  mockAgentEmailMessage(`message_${suffix}`, id, organizationId, now),
                )
              : mockAgentEmailMessage("message_mock", id, organizationId, now),
          matched: true,
        };
      }
      if (childId === "search") {
        return {
          data: mockAgentEmailPage((suffix) =>
            mockAgentEmailMessage(`message_${suffix}`, id, organizationId, now),
          ),
          matched: true,
        };
      }
    }
    if (child === "threads") {
      if (!childId) {
        return {
          data: mockAgentEmailPage((suffix) =>
            mockAgentEmailThread(`thread_${suffix}`, id, organizationId, now),
          ),
          matched: true,
        };
      }
      if (childId === "search") {
        return {
          data: mockAgentEmailPage((suffix) =>
            mockAgentEmailThread(`thread_${suffix}`, id, organizationId, now),
          ),
          matched: true,
        };
      }
      const thread = mockAgentEmailThread(childId, id, organizationId, now);
      const detail: AgentEmailThreadDetail = {
        messages: [mockAgentEmailMessage("message_mock", id, organizationId, now, childId)],
        thread,
      };
      return { data: detail, matched: true };
    }
    if (child === "drafts") {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailDraft(`draft_${suffix}`, id, organizationId, now),
              )
            : mockAgentEmailDraft("draft_mock", id, organizationId, now),
        matched: true,
      };
    }
  }

  if (resource === "messages" && id) {
    if (child === "raw" && childId === "access") {
      const access: AgentEmailAccessUrl = {
        expiresAt: now,
        url: `https://mock.invalid/agent-email/messages/${encodeURIComponent(id)}/raw`,
      };
      return { data: access, matched: true };
    }
    if (child === "reply" || child === "reply-all" || child === "forward") {
      return {
        data: mockAgentEmailMessage(
          `message_${child.replaceAll("-", "_")}_${id}`,
          "inbox_mock",
          organizationId,
          now,
        ),
        matched: true,
      };
    }
    return { data: mockAgentEmailMessage(id, "inbox_mock", organizationId, now), matched: true };
  }

  if (resource === "bindings" && id) {
    return {
      data: mockAgentEmailBinding(id, "inbox_mock", organizationId, now),
      matched: true,
    };
  }

  if (resource === "attachments" && id && child === "access-url") {
    const access: AgentEmailAccessUrl = {
      expiresAt: now,
      url: `https://mock.invalid/agent-email/attachments/${encodeURIComponent(id)}`,
    };
    return { data: access, matched: true };
  }

  if (resource === "placements") {
    if (!id) {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailPlacement(`placement_${suffix}`, organizationId, now),
              )
            : mockAgentEmailPlacement("placement_mock", organizationId, now),
        matched: true,
      };
    }
    return { data: mockAgentEmailPlacement(id, organizationId, now), matched: true };
  }

  if (resource === "drafts" && id) {
    if (child === "send") {
      return {
        data: mockAgentEmailMessage(`message_${id}`, "inbox_mock", organizationId, now),
        matched: true,
      };
    }
    const statusByAction: Partial<Record<string, AgentEmailDraftRecord["status"]>> = {
      approve: "approved",
      cancel: "cancelled",
      reject: "rejected",
      submit: "pending_approval",
    };
    return {
      data: mockAgentEmailDraft(
        id,
        "inbox_mock",
        organizationId,
        now,
        (child && statusByAction[child]) || "draft",
      ),
      matched: true,
    };
  }

  if (resource === "usage") {
    if (id === "export") {
      const body =
        typeof request.body === "object" && request.body !== null
          ? (request.body as Record<string, unknown>)
          : {};
      const bucket =
        body.bucket === "hour" || body.bucket === "month" ? body.bucket : ("day" as const);
      const format = body.format === "csv" ? ("csv" as const) : ("json" as const);
      const from = typeof body.from === "string" ? body.from : now;
      const to = typeof body.to === "string" ? body.to : now;
      const rows = [
        {
          bucketStart: from,
          kind: "outbound_message" as const,
          organizationId,
          quantity: 1,
        },
      ];
      const data: AgentEmailUsageExport = {
        bucket,
        format,
        from,
        rows,
        to,
        ...(format === "csv"
          ? {
              csv: [
                "bucketStart,kind,organizationId,quantity",
                `${from},outbound_message,${organizationId},1`,
              ].join("\n"),
            }
          : {}),
      };
      return { data, matched: true };
    }
    const data: AgentEmailUsageSummary = {
      attachmentBytes: 0,
      from: now,
      inboundMessages: 1,
      organizationId,
      outboundMessages: 1,
      storedBytes: 0,
      to: now,
    };
    return { data, matched: true };
  }

  if (resource === "policy") {
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const data: AgentEmailPolicyRecord = {
      bounceRateThresholdBasisPoints:
        typeof body.bounceRateThresholdBasisPoints === "number"
          ? body.bounceRateThresholdBasisPoints
          : 500,
      complaintRateThresholdBasisPoints:
        typeof body.complaintRateThresholdBasisPoints === "number"
          ? body.complaintRateThresholdBasisPoints
          : 10,
      createdAt: now,
      dailyOutboundMessageLimit:
        typeof body.dailyOutboundMessageLimit === "number" ? body.dailyOutboundMessageLimit : 100,
      id: "policy_mock",
      maxAttachmentBytes:
        typeof body.maxAttachmentBytes === "number" ? body.maxAttachmentBytes : 4 * 1024 * 1024,
      maxRecipientsPerMessage:
        typeof body.maxRecipientsPerMessage === "number" ? body.maxRecipientsPerMessage : 10,
      organizationId,
      rawRetentionDays: typeof body.rawRetentionDays === "number" ? body.rawRetentionDays : 30,
      sendingStatus: "active",
      updatedAt: now,
      warmupStage: "production",
    };
    return { data, matched: true };
  }

  if (resource === "suppressions") {
    if (!id) {
      return {
        data:
          request.method === "GET"
            ? mockAgentEmailPage((suffix) =>
                mockAgentEmailSuppression(`suppression_${suffix}`, organizationId, now),
              )
            : mockAgentEmailSuppression("suppression_mock", organizationId, now),
        matched: true,
      };
    }
    return { data: mockAgentEmailSuppression(id, organizationId, now), matched: true };
  }

  return { matched: false };
}
