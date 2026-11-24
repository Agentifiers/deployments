import { createHash } from "node:crypto";
import {
  DkimSigningAttributesOrigin,
  type GetEmailIdentityCommandOutput,
  type Tag,
} from "@aws-sdk/client-sesv2";
import type { AgentEmailDnsRecord, AgentEmailDomainRecord } from "../../core/index.ts";

export class AgentEmailDomainIdentityMissingError extends Error {
  constructor(domain: string, options: ErrorOptions = {}) {
    super(`Amazon SES identity ${domain} does not exist.`, options);
    this.name = "AgentEmailDomainIdentityMissingError";
  }
}

export class AgentEmailDomainIdentityOwnershipError extends Error {
  constructor(domain: string) {
    super(`Amazon SES identity ${domain} is not owned by this email domain record.`);
    this.name = "AgentEmailDomainIdentityOwnershipError";
  }
}

export function agentEmailDomainOwnershipRecord(domain: AgentEmailDomainRecord) {
  return domain.dnsRecords.find(
    (record) =>
      record.type === "TXT" &&
      record.name === `_agent-email.${domain.domain}` &&
      record.value.startsWith("agent-email-verification="),
  );
}

export function agentEmailDomainOwnershipVerified(
  domain: AgentEmailDomainRecord,
  answers: readonly (readonly string[])[],
) {
  const expected = agentEmailDomainOwnershipRecord(domain)?.value;
  return Boolean(expected && answers.some((parts) => parts.join("") === expected));
}

export function agentEmailDeterministicDkimOrigin(parentRegion: string) {
  const value = `AWS_SES_${parentRegion.replaceAll("-", "_").toUpperCase()}`;
  if (!(Object.values(DkimSigningAttributesOrigin) as readonly string[]).includes(value)) {
    throw new Error(
      `Amazon SES deterministic DKIM does not support parent region ${parentRegion}.`,
    );
  }
  return value as (typeof DkimSigningAttributesOrigin)[keyof typeof DkimSigningAttributesOrigin];
}

const REGIONAL_SES_DKIM_REGIONS = new Set([
  "af-south-1",
  "ap-northeast-3",
  "ap-south-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ca-west-1",
  "eu-central-2",
  "eu-south-1",
  "il-central-1",
  "me-central-1",
  "us-gov-east-1",
]);

export function agentEmailSesDkimDomain(region: string, signingHostedZone?: string) {
  const providerZone = signingHostedZone?.trim().replace(/\.$/u, "");
  if (providerZone) return providerZone;
  return REGIONAL_SES_DKIM_REGIONS.has(region)
    ? `dkim.${region}.amazonses.com`
    : "dkim.amazonses.com";
}

function dnsRecords(
  domain: AgentEmailDomainRecord,
  identity: GetEmailIdentityCommandOutput,
  options: {
    readonly mode?: "receiving" | "send-only";
    readonly region: string;
    readonly secondaryRegion?: string;
  },
): readonly AgentEmailDnsRecord[] {
  const ownershipRecord = agentEmailDomainOwnershipRecord(domain);
  const dkimDomain = agentEmailSesDkimDomain(
    options.region,
    identity.DkimAttributes?.SigningHostedZone,
  );
  const secondaryMailFromDomain = options.secondaryRegion
    ? agentEmailRegionalMailFromDomain(domain, options.secondaryRegion)
    : undefined;
  return [
    ...(ownershipRecord ? [ownershipRecord] : []),
    ...(identity.DkimAttributes?.Tokens ?? []).map((token) => ({
      name: `${token}._domainkey.${domain.domain}`,
      type: "CNAME" as const,
      value: `${token}.${dkimDomain}`,
    })),
    ...(options.mode === "send-only"
      ? []
      : [
          {
            name: domain.domain,
            priority: 10,
            type: "MX" as const,
            value: `inbound-smtp.${options.region}.amazonaws.com`,
          },
        ]),
    {
      name: domain.mailFromDomain,
      priority: 10,
      type: "MX" as const,
      value: `feedback-smtp.${options.region}.amazonses.com`,
    },
    {
      name: domain.mailFromDomain,
      type: "TXT" as const,
      value: "v=spf1 include:amazonses.com -all",
    },
    ...(secondaryMailFromDomain && options.secondaryRegion
      ? [
          {
            name: secondaryMailFromDomain,
            priority: 10,
            type: "MX" as const,
            value: `feedback-smtp.${options.secondaryRegion}.amazonses.com`,
          },
          {
            name: secondaryMailFromDomain,
            type: "TXT" as const,
            value: "v=spf1 include:amazonses.com -all",
          },
        ]
      : []),
  ];
}

export function agentEmailRegionalMailFromDomain(domain: AgentEmailDomainRecord, region: string) {
  const regionHash = createHash("sha256").update(region).digest("hex").slice(0, 8);
  const value = `b-${regionHash}.${domain.domain}`;
  if (value.length > 253) {
    throw new Error(`Email domain ${domain.domain} is too long for multi-region MAIL FROM.`);
  }
  return value;
}

export function agentEmailDomainIdentityState(
  domain: AgentEmailDomainRecord,
  identity: GetEmailIdentityCommandOutput,
  options: {
    readonly mode?: "receiving" | "send-only";
    readonly now: Date;
    readonly region: string;
    readonly secondary?: {
      readonly identity: GetEmailIdentityCommandOutput;
      readonly region: string;
    };
  },
): AgentEmailDomainRecord {
  const regionalIdentities = [
    {
      expectedMailFromDomain: domain.mailFromDomain,
      identity,
      region: options.region,
      role: "primary" as const,
    },
    ...(options.secondary
      ? [
          {
            expectedMailFromDomain: agentEmailRegionalMailFromDomain(
              domain,
              options.secondary.region,
            ),
            identity: options.secondary.identity,
            region: options.secondary.region,
            role: "secondary" as const,
          },
        ]
      : []),
  ];
  const failed = regionalIdentities.some(
    ({ expectedMailFromDomain, identity: regionalIdentity }) =>
      regionalIdentity.VerificationStatus === "FAILED" ||
      regionalIdentity.DkimAttributes?.Status === "FAILED" ||
      regionalIdentity.MailFromAttributes?.MailFromDomainStatus === "FAILED" ||
      (regionalIdentity.MailFromAttributes?.MailFromDomain !== undefined &&
        regionalIdentity.MailFromAttributes.MailFromDomain !== expectedMailFromDomain),
  );
  const verified = regionalIdentities.every(
    ({ expectedMailFromDomain, identity: regionalIdentity }) =>
      regionalIdentity.VerifiedForSendingStatus === true &&
      regionalIdentity.VerificationStatus === "SUCCESS" &&
      regionalIdentity.DkimAttributes?.Status === "SUCCESS" &&
      regionalIdentity.MailFromAttributes?.MailFromDomainStatus === "SUCCESS" &&
      regionalIdentity.MailFromAttributes.MailFromDomain === expectedMailFromDomain,
  );
  const now = options.now.toISOString();
  const { failureReason: _failureReason, ...currentDomain } = domain;
  return {
    ...currentDomain,
    dnsRecords: dnsRecords(domain, identity, {
      ...(options.mode ? { mode: options.mode } : {}),
      region: options.region,
      ...(options.secondary ? { secondaryRegion: options.secondary.region } : {}),
    }),
    ...(failed
      ? { failureReason: "Amazon SES could not verify one or more required DNS records." }
      : {}),
    lastCheckedAt: now,
    providerIdentity: domain.domain,
    providerMetadata: {
      ...domain.providerMetadata,
      ...(options.mode === "send-only" ? {} : { inboundRegion: options.region }),
      multiRegionOutbound: Boolean(options.secondary),
      regionalIdentities: regionalIdentities.map(
        ({ expectedMailFromDomain, identity: regionalIdentity, region, role }) => ({
          dkimStatus: regionalIdentity.DkimAttributes?.Status ?? "PENDING",
          expectedMailFromDomain,
          mailFromDomain: regionalIdentity.MailFromAttributes?.MailFromDomain ?? "NOT_CONFIGURED",
          mailFromStatus:
            regionalIdentity.MailFromAttributes?.MailFromDomainStatus ?? "NOT_CONFIGURED",
          region,
          role,
          verificationStatus: regionalIdentity.VerificationStatus ?? "PENDING",
          verifiedForSending: regionalIdentity.VerifiedForSendingStatus === true,
        }),
      ),
    },
    status: failed ? "failed" : verified ? "verified" : "pending_dns",
    updatedAt: now,
    ...(verified && !domain.verifiedAt ? { verifiedAt: now } : {}),
  };
}

export function agentEmailIdentityTagsMatch(domain: AgentEmailDomainRecord, tags: readonly Tag[]) {
  const values = new Map(tags.map((tag) => [tag.Key, tag.Value]));
  return (
    values.get("agent-inboxes:organization-id") === domain.organizationId &&
    values.get("agent-inboxes:resource-id") === domain.id
  );
}

export async function revokeAgentEmailDomainIdentity(
  domain: AgentEmailDomainRecord,
  dependencies: {
    readonly deleteIdentity: () => Promise<void>;
    readonly identityExistsAndIsOwned: () => Promise<boolean>;
    readonly now: () => Date;
  },
) {
  let identityExistsAndIsOwned = false;
  try {
    identityExistsAndIsOwned = await dependencies.identityExistsAndIsOwned();
  } catch (cause) {
    if (!(cause instanceof AgentEmailDomainIdentityOwnershipError)) throw cause;
  }
  if (identityExistsAndIsOwned) await dependencies.deleteIdentity();
  const now = dependencies.now().toISOString();
  const {
    providerIdentity: _providerIdentity,
    providerMetadata: _providerMetadata,
    ...revokedDomain
  } = domain;
  return {
    ...revokedDomain,
    dnsRecords: [],
    lastCheckedAt: now,
    providerMetadata: {},
    status: "revoked" as const,
    updatedAt: now,
  };
}
