import type { AgentEmailDomainRecord } from "@deployments-ai/agent-email";
import {
  AgentEmailDomainIdentityOwnershipError,
  EmailSesSendError,
  emailSesTenantNames,
  type EmailSesTenant,
} from "@deployments-ai/agent-email/aws";
import {
  CreateEmailDomainRequest,
  CreateEmailTenantRequest,
  EmailListQuery,
  SendEmailRequest,
  UpdateEmailTenantRequest,
  normalizeEmailMailbox,
  normalizeEmailDomain,
  EmailDomainResponse,
  EmailSendResponse,
  EmailTenantResponse,
} from "@deployments-ai/api-contract/email";
import {
  PersistenceError,
  makeEmailPersistence,
  makeIdGenerator,
  type DynamoDatabaseService,
  type EmailDomainRecord,
  type EmailPersistenceEvent,
  type EmailTenantRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { AgentEmailApiInvocation } from "./api-handler.ts";
import type { EmailApiOperation } from "./api-routes.ts";
import {
  apiError,
  decodePublicRequest,
  platformScope,
  requiredBody,
  requiredParameter,
} from "./application-service-support.ts";
import { emailProviderDomain, type EmailProviderRuntime } from "./email-provider-runtime.ts";

export interface EmailApplicationService {
  execute(operation: EmailApiOperation, invocation: AgentEmailApiInvocation): Promise<unknown>;
}

export interface EmailApplicationServiceDependencies {
  readonly database: DynamoDatabaseService;
  readonly providers: EmailProviderRuntime;
  readonly region: string;
  readonly createId?: () => string | Promise<string>;
  readonly now?: () => Date;
}

function nativeTenantData(
  record: EmailTenantRecord,
  native: EmailSesTenant,
): EmailTenantRecord["data"] {
  const { providerId: _providerId, providerArn: _providerArn, ...data } = record.data;
  return {
    ...data,
    ...(native.providerId === undefined ? {} : { providerId: native.providerId }),
    ...(native.providerArn === undefined ? {} : { providerArn: native.providerArn }),
    sendingStatus: native.sendingStatus,
  };
}

function tenantResponse(record: EmailTenantRecord): EmailTenantResponse {
  const {
    version: _version,
    providerMetadata: _providerMetadata,
    awsManagedStatus: _awsManagedStatus,
    customerManagedStatus: _customerManagedStatus,
    ...response
  } = record.data;
  return Schema.decodeUnknownSync(EmailTenantResponse)(response);
}

function domainResponse(record: EmailDomainRecord): EmailDomainResponse {
  const {
    version: _version,
    providerMetadata: _providerMetadata,
    providerIdentity: _providerIdentity,
    revocationCompletedAt: _revocationCompletedAt,
    ...response
  } = record.data;
  return Schema.decodeUnknownSync(EmailDomainResponse)(response);
}

export function createEmailApplicationService(
  dependencies: EmailApplicationServiceDependencies,
): EmailApplicationService {
  const ids = makeIdGenerator();
  const createId = async () => (await (dependencies.createId?.() ?? ids.generate())) as Ulid;
  const now = () => (dependencies.now?.() ?? new Date()).toISOString();
  const { providers } = dependencies;

  async function event(eventType: string): Promise<EmailPersistenceEvent> {
    return { eventId: await createId(), eventType, occurredAt: now() };
  }

  function repository(invocation: AgentEmailApiInvocation) {
    return makeEmailPersistence(dependencies.database, platformScope(invocation.scope));
  }

  async function requireTenant(invocation: AgentEmailApiInvocation, id?: string) {
    const tenant = await repository(invocation).getTenant(
      (id ?? requiredParameter(invocation, "tenantId")) as Ulid,
    );
    return tenant ?? apiError(404, "email_tenant_not_found", "The email tenant was not found.");
  }

  async function requireDomain(invocation: AgentEmailApiInvocation) {
    const domain = await repository(invocation).getDomain(
      requiredParameter(invocation, "domainId") as Ulid,
    );
    return domain ?? apiError(404, "email_domain_not_found", "The email domain was not found.");
  }

  async function createTenant(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateEmailTenantRequest, requiredBody(invocation), true);
    const id = await createId();
    const timestamp = now();
    const selected = repository(invocation);
    const pending = await selected.createTenant(
      {
        itemType: "email-tenant",
        data: {
          ...platformScope(invocation.scope),
          ...emailSesTenantNames(id),
          id,
          name: input.name.trim(),
          status: "active",
          region: dependencies.region,
          sendingStatus: "provisioning",
          providerMetadata: {},
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      await event("email.tenant-created"),
    );
    const provisioned = await providers.provisionTenant(pending.data, false);
    const saved = await selected.updateTenant(
      {
        ...pending,
        data: { ...nativeTenantData(pending, provisioned), updatedAt: now() },
      },
      await event("email.tenant-updated"),
    );
    if (!saved) apiError(404, "email_tenant_not_found", "The email tenant was not found.");
    return tenantResponse(saved);
  }

  async function updateTenant(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(UpdateEmailTenantRequest, requiredBody(invocation), true);
    const existing = await requireTenant(invocation);
    const selected = repository(invocation);
    // Commit local pause before touching SES: provider failures must not leave sending enabled.
    const changed = await selected.updateTenant(
      {
        ...existing,
        data: {
          ...existing.data,
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.status === undefined ? {} : { status: input.status }),
          updatedAt: now(),
        },
      },
      await event("email.tenant-updated"),
    );
    if (!changed) apiError(404, "email_tenant_not_found", "The email tenant was not found.");
    const native =
      input.status !== undefined || changed.data.sendingStatus === "provisioning"
        ? await providers.provisionTenant(changed.data, input.status !== undefined)
        : await providers.readTenant(changed.data);
    const saved = await selected.updateTenant(
      {
        ...changed,
        data: { ...nativeTenantData(changed, native), updatedAt: now() },
      },
      await event("email.tenant-updated"),
    );
    if (!saved) apiError(404, "email_tenant_not_found", "The email tenant was not found.");
    return tenantResponse(saved);
  }

  async function getTenant(invocation: AgentEmailApiInvocation) {
    const tenant = await requireTenant(invocation);
    // Reads expose native suspension without mutating customer-managed reputation status.
    const native = await providers.readTenant(tenant.data);
    return tenantResponse({ ...tenant, data: nativeTenantData(tenant, native) });
  }

  async function listTenants(invocation: AgentEmailApiInvocation) {
    const query = decodePublicRequest(EmailListQuery, invocation.query, true);
    const page = await repository(invocation).listTenants(query);
    const items = await Promise.all(
      page.items.map(async (tenant) => {
        const native = await providers.readTenant(tenant.data);
        return tenantResponse({ ...tenant, data: nativeTenantData(tenant, native) });
      }),
    );
    return { ...page, items };
  }

  async function createDomain(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateEmailDomainRequest, requiredBody(invocation), true);
    const tenant = await requireTenant(invocation);
    const domain = normalizeEmailDomain(input.domain);
    const id = await createId();
    const timestamp = now();
    const saved = await repository(invocation).createDomain(
      {
        itemType: "email-domain",
        data: {
          ...platformScope(invocation.scope),
          id,
          tenantId: tenant.data.id,
          domain,
          status: "pending",
          dnsRecords: [
            {
              name: `_agent-email.${domain}`,
              type: "TXT",
              value: `agent-email-verification=${id.toLowerCase()}`,
            },
          ],
          mailFromDomain: `bounce.${domain}`,
          providerMetadata: {},
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
      await event("email.domain-created"),
    );
    return domainResponse(saved);
  }

  async function saveDomain(
    invocation: AgentEmailApiInvocation,
    existing: EmailDomainRecord,
    changed: AgentEmailDomainRecord,
    cleanupComplete = false,
  ) {
    const selected = repository(invocation);
    const update = cleanupComplete ? selected.completeDomainRevocation : selected.updateDomain;
    const {
      failureReason: _failureReason,
      providerIdentity: _providerIdentity,
      lastCheckedAt: _lastCheckedAt,
      verifiedAt: _verifiedAt,
      ...data
    } = existing.data;
    const verifiedAt = existing.data.verifiedAt ?? changed.verifiedAt;
    const saved = await update(
      {
        ...existing,
        data: {
          ...data,
          dnsRecords: changed.dnsRecords,
          mailFromDomain: changed.mailFromDomain,
          status: changed.status,
          ...(changed.failureReason === undefined ? {} : { failureReason: changed.failureReason }),
          ...(changed.providerIdentity === undefined
            ? {}
            : { providerIdentity: changed.providerIdentity }),
          providerMetadata:
            changed.providerMetadata as EmailDomainRecord["data"]["providerMetadata"],
          ...(changed.lastCheckedAt === undefined ? {} : { lastCheckedAt: changed.lastCheckedAt }),
          ...(verifiedAt === undefined ? {} : { verifiedAt }),
          updatedAt: now(),
        },
      },
      await event("email.domain-updated"),
    );
    if (!saved) apiError(404, "email_domain_not_found", "The email domain was not found.");
    return saved;
  }

  async function refreshDomain(invocation: AgentEmailApiInvocation) {
    const existing = await requireDomain(invocation);
    if (existing.data.status === "revoked") {
      apiError(409, "email_domain_revoked", "Revoked email domains cannot be refreshed.");
    }
    const tenant = await requireTenant(invocation, existing.data.tenantId);
    const provisioner = providers.domainProvisioner(tenant.data);
    let changed: AgentEmailDomainRecord;
    try {
      // Provisioning rechecks the ownership TXT and identity tags even for existing identities.
      changed = await provisioner.provision(emailProviderDomain(existing));
    } catch (cause) {
      if (!(cause instanceof AgentEmailDomainIdentityOwnershipError)) throw cause;
      changed = {
        ...emailProviderDomain(existing),
        status: "failed",
        failureReason: "The provider identity belongs to another email domain record.",
        lastCheckedAt: now(),
      };
    }
    return domainResponse(await saveDomain(invocation, existing, changed));
  }

  async function revokeDomain(invocation: AgentEmailApiInvocation) {
    let existing = await requireDomain(invocation);
    if (existing.data.revocationCompletedAt) return domainResponse(existing);
    const tenant = await requireTenant(invocation, existing.data.tenantId);
    if (existing.data.status !== "revoked") {
      existing = await saveDomain(invocation, existing, {
        ...emailProviderDomain(existing),
        status: "revoked",
      });
    }
    // Keep the claim and provider metadata until owned cleanup succeeds; retries remain safe.
    const changed = await providers
      .domainProvisioner(tenant.data)
      .revoke(emailProviderDomain(existing));
    return domainResponse(await saveDomain(invocation, existing, changed, true));
  }

  async function sendEmail(invocation: AgentEmailApiInvocation): Promise<EmailSendResponse> {
    const message = decodePublicRequest(SendEmailRequest, requiredBody(invocation), true);
    const tenant = await requireTenant(invocation);
    if (tenant.data.status !== "active") {
      apiError(409, "email_tenant_paused", "The email tenant is paused.");
    }
    const from = normalizeEmailMailbox(message.from);
    const domain = await repository(invocation).findDomainByName(from.domain);
    if (!domain || domain.data.tenantId !== tenant.data.id || domain.data.status !== "verified") {
      apiError(
        409,
        "email_domain_not_verified",
        "The From domain must be verified in this email tenant.",
      );
    }
    const normalizedMessage = {
      ...message,
      from: from.mailbox,
      to: message.to.map((value) => normalizeEmailMailbox(value).mailbox),
      ...(message.cc
        ? { cc: message.cc.map((value) => normalizeEmailMailbox(value).mailbox) }
        : {}),
      ...(message.bcc
        ? { bcc: message.bcc.map((value) => normalizeEmailMailbox(value).mailbox) }
        : {}),
      ...(message.replyTo
        ? { replyTo: message.replyTo.map((value) => normalizeEmailMailbox(value).mailbox) }
        : {}),
    };
    const id = await createId();
    try {
      const accepted = await providers.send(tenant.data, normalizedMessage);
      return Schema.decodeUnknownSync(EmailSendResponse)({
        id,
        tenantId: tenant.data.id,
        status: "accepted",
        providerMessageId: accepted.providerMessageId,
        acceptedAt: now(),
      });
    } catch (cause) {
      if (!(cause instanceof EmailSesSendError)) {
        // Once the non-idempotent provider call begins, unknown failures cannot authorize a resend.
        throw new PersistenceError(
          "internal",
          "ambiguous_write_outcome",
          "The email send outcome is unknown.",
        );
      }
      if (cause.outcome === "ambiguous") {
        throw new PersistenceError(
          "internal",
          "ambiguous_write_outcome",
          "The email send outcome is unknown.",
        );
      }
      apiError(cause.status, cause.code, cause.message);
    }
  }

  return {
    async execute(
      operation: EmailApiOperation,
      invocation: AgentEmailApiInvocation,
    ): Promise<unknown> {
      switch (operation) {
        case "createEmailTenant":
          return createTenant(invocation);
        case "listEmailTenants":
          return listTenants(invocation);
        case "getEmailTenant":
          return getTenant(invocation);
        case "updateEmailTenant":
          return updateTenant(invocation);
        case "createEmailDomain":
          return createDomain(invocation);
        case "getEmailDomain":
          return domainResponse(await requireDomain(invocation));
        case "listEmailDomains": {
          const tenant = await requireTenant(invocation);
          const query = decodePublicRequest(EmailListQuery, invocation.query, true);
          const page = await repository(invocation).listDomains(tenant.data.id, query);
          return { ...page, items: page.items.map(domainResponse) };
        }
        case "refreshEmailDomain":
          return refreshDomain(invocation);
        case "revokeEmailDomain":
          return revokeDomain(invocation);
        case "sendEmail":
          return sendEmail(invocation);
      }
    },
  };
}
