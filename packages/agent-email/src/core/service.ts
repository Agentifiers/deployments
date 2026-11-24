import { domainToASCII } from "node:url";
import { Schema } from "effect";
import {
  CreateAgentEmailDomainRequest,
  CreateAgentEmailInboxRequest,
  UpdateAgentEmailInboxRequest,
} from "./contracts.ts";
import type {
  AgentEmailDomainRecord,
  AgentEmailInboxStatus,
  AgentEmailMessageRecord,
} from "./models.ts";
import type { AgentEmailDomainStore, AgentEmailInboxStore } from "./ports.ts";

const LOCAL_PART_PATTERN = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/u;
const MAX_DNS_NAME_LENGTH = 253;
const MAX_DNS_LABEL_LENGTH = 63;

export function agentEmailTenantObjectPrefix(scope: {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return `organizations/${scope.organizationId}/projects/${scope.projectId}/environments/${scope.environmentId}/agent-email`;
}

export class AgentEmailValidationError extends Schema.TaggedErrorClass<AgentEmailValidationError>()(
  "AgentEmailValidationError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class AgentEmailNotFoundError extends Schema.TaggedErrorClass<AgentEmailNotFoundError>()(
  "AgentEmailNotFoundError",
  {
    id: Schema.String,
    resource: Schema.String,
  },
) {}

export class AgentEmailConflictError extends Schema.TaggedErrorClass<AgentEmailConflictError>()(
  "AgentEmailConflictError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

export function normalizeAgentEmailDomain(value: string) {
  const input = value.trim();
  const normalized = /[\s%/@:\\?#]/u.test(input)
    ? ""
    : domainToASCII(input).toLowerCase().replace(/\.$/u, "");
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new AgentEmailValidationError({
      field: "domain",
      message: "Domain is invalid.",
    });
  }
  return normalized;
}

export function validateAgentEmailDomainDkimRecords(domain: string) {
  if (`${"x".repeat(MAX_DNS_LABEL_LENGTH)}._domainkey.${domain}`.length > MAX_DNS_NAME_LENGTH) {
    throw new AgentEmailValidationError({
      field: "domain",
      message: "Domain is too long for the required DKIM DNS records.",
    });
  }
}

export function normalizeAgentEmailLocalPart(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!LOCAL_PART_PATTERN.test(normalized)) {
    throw new AgentEmailValidationError({
      field: "localPart",
      message:
        "Local part must contain 1-64 lowercase letters, numbers, dots, underscores, or hyphens.",
    });
  }
  return normalized;
}

export function agentEmailAddress(localPart: string, domain: string) {
  return `${normalizeAgentEmailLocalPart(localPart)}@${normalizeAgentEmailDomain(domain)}`;
}

export function normalizeAgentEmailPageLimit(value: number | undefined, maximum = 100) {
  if (value === undefined || !Number.isFinite(value)) return Math.min(50, maximum);
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

export function agentEmailCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

export function parseAgentEmailCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("createdAt" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string" ||
      Number.isNaN(new Date(decoded.createdAt).getTime())
    ) {
      throw new Error("invalid");
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new AgentEmailValidationError({
      field: "cursor",
      message: "Cursor is invalid.",
    });
  }
}

function prefixedSubject(subject: string, prefix: "Fwd" | "Re") {
  const normalized = subject.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/giu, "");
  return `${prefix}: ${normalized || "(no subject)"}`;
}

export function agentEmailReplySubject(subject: string) {
  return prefixedSubject(subject, "Re");
}

export function agentEmailForwardSubject(subject: string) {
  return prefixedSubject(subject, "Fwd");
}

export function agentEmailReplyRecipients(
  message: AgentEmailMessageRecord,
  inboxAddress: string,
  replyAll: boolean,
) {
  const ownAddress = inboxAddress.trim().toLowerCase();
  const primary =
    message.direction === "outbound"
      ? message.toAddresses
      : message.replyToAddresses.length > 0
        ? message.replyToAddresses
        : [message.fromAddress];
  const candidates = replyAll
    ? [...primary, ...message.toAddresses, ...message.ccAddresses]
    : primary;
  const seen = new Set<string>();
  return candidates.filter((address) => {
    const normalized = address.trim().toLowerCase();
    if (!normalized || normalized === ownAddress || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function agentEmailForwardText(message: AgentEmailMessageRecord) {
  const recipients = message.toAddresses.join(", ");
  return [
    "",
    "---------- Forwarded message ----------",
    `From: ${message.fromAddress}`,
    `To: ${recipients}`,
    `Subject: ${message.subject}`,
    "",
    message.textBody ?? "",
  ].join("\n");
}

function escapeAgentEmailHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function agentEmailForwardHtml(message: AgentEmailMessageRecord) {
  const recipients = message.toAddresses.join(", ");
  const original = message.htmlBody ?? `<pre>${escapeAgentEmailHtml(message.textBody ?? "")}</pre>`;
  return `<br><div>---------- Forwarded message ----------<br><strong>From:</strong> ${escapeAgentEmailHtml(message.fromAddress)}<br><strong>To:</strong> ${escapeAgentEmailHtml(recipients)}<br><strong>Subject:</strong> ${escapeAgentEmailHtml(message.subject)}<br><br>${original}</div>`;
}

export interface AgentEmailServiceDependencies {
  readonly createDomainVerificationToken?: (domainId: string) => string;
  readonly createDomainId: () => string;
  readonly createInboxId: () => string;
  readonly defaultDomain: (organizationId: string) => Promise<AgentEmailDomainRecord>;
  readonly domains: AgentEmailDomainStore;
  readonly generateLocalPart: () => string;
  readonly inboxes: AgentEmailInboxStore;
  readonly now?: () => Date;
}

export function makeAgentEmailService(dependencies: AgentEmailServiceDependencies) {
  const now = () => dependencies.now?.() ?? new Date();

  return {
    async createDomain(organizationId: string, input: CreateAgentEmailDomainRequest) {
      const clock = now().toISOString();
      const domain = normalizeAgentEmailDomain(input.domain);
      validateAgentEmailDomainDkimRecords(domain);
      const id = dependencies.createDomainId();
      const verificationToken =
        dependencies.createDomainVerificationToken?.(id) ?? id.toLowerCase();
      return dependencies.domains.create({
        createdAt: clock,
        dnsRecords: [
          {
            name: `_agent-email.${domain}`,
            type: "TXT",
            value: `agent-email-verification=${verificationToken}`,
          },
        ],
        domain,
        id,
        mailFromDomain: `bounce.${domain}`,
        organizationId,
        ...(input.placementId?.trim() ? { placementId: input.placementId.trim() } : {}),
        providerManaged: false,
        providerMetadata: {},
        status: "pending",
        updatedAt: clock,
      });
    },

    async createInbox(organizationId: string, input: CreateAgentEmailInboxRequest) {
      const selectedDomain = input.domainId
        ? await dependencies.domains.get(organizationId, input.domainId)
        : await dependencies.defaultDomain(organizationId);
      if (!selectedDomain || selectedDomain.organizationId !== organizationId) {
        throw new AgentEmailNotFoundError({
          id: input.domainId ?? "default",
          resource: "domain",
        });
      }
      const created = await dependencies.domains.withLock(
        organizationId,
        selectedDomain.id,
        async (domain, inboxes) => {
          if (domain.status !== "verified") {
            throw new AgentEmailConflictError({
              field: "domainId",
              message: "Domain must be verified before creating inboxes.",
            });
          }
          const localPart = normalizeAgentEmailLocalPart(
            input.localPart ?? dependencies.generateLocalPart(),
          );
          const address = agentEmailAddress(localPart, domain.domain);
          if (await inboxes.findByAddress(organizationId, address)) {
            throw new AgentEmailConflictError({
              field: "localPart",
              message: "Email inbox address is already in use.",
            });
          }
          const clock = now().toISOString();
          return inboxes.create({
            address,
            ...(input.clientId ? { clientId: input.clientId } : {}),
            createdAt: clock,
            domainId: domain.id,
            id: dependencies.createInboxId(),
            localPart,
            metadata: input.metadata ?? {},
            ...(input.name?.trim() ? { name: input.name.trim().slice(0, 120) } : {}),
            organizationId,
            status: "active",
            updatedAt: clock,
          });
        },
      );
      if (!created) {
        throw new AgentEmailNotFoundError({ id: selectedDomain.id, resource: "domain" });
      }
      return created;
    },

    async updateInbox(
      organizationId: string,
      inboxId: string,
      input: UpdateAgentEmailInboxRequest,
    ) {
      const selectedInbox = await dependencies.inboxes.get(organizationId, inboxId);
      if (!selectedInbox) throw new AgentEmailNotFoundError({ id: inboxId, resource: "inbox" });
      const updated = await dependencies.domains.withLock(
        organizationId,
        selectedInbox.domainId,
        async (domain, inboxes) => {
          const existing = await inboxes.get(organizationId, inboxId);
          if (!existing) throw new AgentEmailNotFoundError({ id: inboxId, resource: "inbox" });
          const status: AgentEmailInboxStatus = input.status ?? existing.status;
          if (status === "active" && domain.status !== "verified") {
            throw new AgentEmailConflictError({
              field: "status",
              message: "Inbox domain must be verified before activation.",
            });
          }
          if (
            domain.status === "revoked" &&
            existing.status === "archived" &&
            status !== "archived"
          ) {
            throw new AgentEmailConflictError({
              field: "status",
              message: "Archived inboxes cannot be reactivated.",
            });
          }
          const { name: _existingName, ...existingWithoutName } = existing;
          return inboxes.update({
            ...existingWithoutName,
            metadata: input.metadata ?? existing.metadata,
            ...(input.name === undefined
              ? existing.name
                ? { name: existing.name }
                : {}
              : input.name.trim()
                ? { name: input.name.trim().slice(0, 120) }
                : {}),
            status,
            updatedAt: now().toISOString(),
          });
        },
      );
      if (!updated) {
        throw new AgentEmailNotFoundError({ id: selectedInbox.domainId, resource: "domain" });
      }
      return updated;
    },
  };
}
