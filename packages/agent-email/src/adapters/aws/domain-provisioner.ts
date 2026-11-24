import { resolveMx as resolveDnsMx, resolveTxt as resolveDnsTxt } from "node:dns/promises";
import {
  CreateTenantResourceAssociationCommand,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DeleteTenantResourceAssociationCommand,
  GetEmailIdentityCommand,
  ListTagsForResourceCommand,
  PutEmailIdentityMailFromAttributesCommand,
  type CreateEmailIdentityRequest,
  type GetEmailIdentityCommandOutput,
  type Tag,
} from "@aws-sdk/client-sesv2";
import type {
  AgentEmailDomainProvisioner,
  AgentEmailDomainRecord,
  AgentEmailPlacementRecord,
} from "../../core/index.ts";
import {
  AgentEmailDomainIdentityMissingError,
  AgentEmailDomainIdentityOwnershipError,
  agentEmailDeterministicDkimOrigin,
  agentEmailDomainIdentityState,
  agentEmailDomainOwnershipRecord,
  agentEmailDomainOwnershipVerified,
  agentEmailIdentityTagsMatch,
  agentEmailRegionalMailFromDomain,
  revokeAgentEmailDomainIdentity,
} from "./domain-state.ts";
export * from "./domain-state.ts";
import { alreadyExists, notFound, sesClient } from "./ses-client.ts";
import { agentEmailSesTenantName } from "./tenancy.ts";

export interface AgentEmailSesDomainOperations {
  readonly associateTenantResource: (tenantName: string, resourceArn: string) => Promise<void>;
  readonly createIdentity: (input: CreateEmailIdentityRequest) => Promise<void>;
  readonly deleteIdentity: (domain: string) => Promise<void>;
  readonly dissociateTenantResource: (tenantName: string, resourceArn: string) => Promise<void>;
  readonly getIdentity: (domain: string) => Promise<GetEmailIdentityCommandOutput>;
  readonly listTags: (resourceArn: string) => Promise<readonly Tag[]>;
  readonly putMailFrom: (domain: string, mailFromDomain: string) => Promise<void>;
}

export interface AgentEmailSesDomainProvisionerOptions {
  readonly accountId: string;
  readonly defaultConfigurationSetName?: string;
  readonly defaultRegion: string;
  readonly mode?: "receiving" | "send-only";
  readonly getPlacement?: (
    organizationId: string,
    placementId: string,
  ) => Promise<AgentEmailPlacementRecord | undefined>;
  readonly hostedDomain?: string;
  readonly inboundReady?: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly operationsForRegion?: (region: string) => AgentEmailSesDomainOperations;
  readonly partition?: string;
  readonly resolveTxt?: (name: string) => Promise<readonly (readonly string[])[]>;
  readonly resolveMx?: (name: string) => Promise<readonly { exchange: string; priority: number }[]>;
  readonly tenantName?: (organizationId: string) => string;
}

function dnsRecordMissing(cause: unknown) {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return false;
  return cause.code === "ENODATA" || cause.code === "ENOTFOUND";
}

function productionOperations(region: string): AgentEmailSesDomainOperations {
  const ses = sesClient(region);
  return {
    associateTenantResource: async (tenantName, resourceArn) => {
      try {
        await ses.send(
          new CreateTenantResourceAssociationCommand({
            ResourceArn: resourceArn,
            TenantName: tenantName,
          }),
        );
      } catch (cause) {
        if (!alreadyExists(cause)) throw cause;
      }
    },
    createIdentity: async (input) => {
      await ses.send(new CreateEmailIdentityCommand(input));
    },
    deleteIdentity: async (domain) => {
      await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    },
    dissociateTenantResource: async (tenantName, resourceArn) => {
      await ses.send(
        new DeleteTenantResourceAssociationCommand({
          ResourceArn: resourceArn,
          TenantName: tenantName,
        }),
      );
    },
    getIdentity: (domain) => ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain })),
    listTags: async (resourceArn) => {
      const response = await ses.send(new ListTagsForResourceCommand({ ResourceArn: resourceArn }));
      return response.Tags ?? [];
    },
    putMailFrom: async (domain, mailFromDomain) => {
      await ses.send(
        new PutEmailIdentityMailFromAttributesCommand({
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
          EmailIdentity: domain,
          MailFromDomain: mailFromDomain,
        }),
      );
    },
  };
}

interface ProvisioningContext {
  readonly configurationSetName?: string;
  readonly primaryRegion: string;
  readonly secondaryRegion?: string;
}

export function makeAgentEmailSesDomainProvisioner(
  options: AgentEmailSesDomainProvisionerOptions,
): AgentEmailDomainProvisioner {
  if (!/^\d{12}$/u.test(options.accountId))
    throw new Error("A 12-digit AWS account ID is required.");
  if (!options.defaultRegion.trim()) throw new Error("A default AWS region is required.");
  const operationsForRegion = options.operationsForRegion ?? productionOperations;
  const inboundReady = options.inboundReady ?? (async () => false);
  const now = options.now ?? (() => new Date());
  const resolveTxt = options.resolveTxt ?? resolveDnsTxt;
  const resolveMx = options.resolveMx ?? resolveDnsMx;
  const tenantName = options.tenantName ?? agentEmailSesTenantName;

  function pendingInboundDomain(
    original: AgentEmailDomainRecord,
    candidate: AgentEmailDomainRecord,
  ) {
    const { verifiedAt: _candidateVerifiedAt, ...pending } = candidate;
    return {
      ...pending,
      ...(original.verifiedAt ? { verifiedAt: original.verifiedAt } : {}),
      status: "pending_dns" as const,
    };
  }

  async function requireInboundRouting(
    original: AgentEmailDomainRecord,
    candidate: AgentEmailDomainRecord,
  ) {
    if (options.mode === "send-only") return candidate;
    if (candidate.status !== "verified") return candidate;
    if (!(await inboundReady())) return pendingInboundDomain(original, candidate);
    const expected = `inbound-smtp.${options.defaultRegion}.amazonaws.com`;
    let records: readonly { exchange: string; priority: number }[] = [];
    try {
      records = await resolveMx(original.domain);
    } catch (cause) {
      if (!dnsRecordMissing(cause)) throw cause;
    }
    const routes = records.map((record) => ({
      exchange: record.exchange.toLowerCase().replace(/\.$/u, ""),
      priority: record.priority,
    }));
    if (
      routes.some((record) => record.exchange === expected && record.priority === 10) &&
      routes.every((record) => record.exchange === expected || record.priority > 10)
    ) {
      return candidate;
    }
    return pendingInboundDomain(original, candidate);
  }

  function requireHostedDomain(domain: AgentEmailDomainRecord) {
    const hostedDomain = options.hostedDomain?.trim().toLowerCase().replace(/\.$/u, "");
    if (!hostedDomain || domain.domain !== hostedDomain) {
      throw new Error(
        `Provider-managed email domain ${domain.domain} is not the configured hosted domain.`,
      );
    }
    if (domain.placementId) {
      throw new Error("Provider-managed hosted email domains cannot use per-record placements.");
    }
  }

  async function readHostedIdentity(domain: AgentEmailDomainRecord) {
    requireHostedDomain(domain);
    try {
      const identity = await operationsForRegion(options.defaultRegion).getIdentity(domain.domain);
      return requireInboundRouting(
        domain,
        agentEmailDomainIdentityState(domain, identity, {
          ...(options.mode ? { mode: options.mode } : {}),
          now: now(),
          region: options.defaultRegion,
        }),
      );
    } catch (cause) {
      if (notFound(cause)) throw new AgentEmailDomainIdentityMissingError(domain.domain, { cause });
      throw cause;
    }
  }

  async function requireDomainOwnership(domain: AgentEmailDomainRecord) {
    if (domain.providerManaged) return true;
    const ownershipRecord = agentEmailDomainOwnershipRecord(domain);
    if (!ownershipRecord) {
      throw new Error(`Email domain ${domain.domain} ownership challenge is missing.`);
    }
    let answers: readonly (readonly string[])[];
    try {
      answers = await resolveTxt(ownershipRecord.name);
    } catch (cause) {
      if (!dnsRecordMissing(cause)) throw cause;
      answers = [];
    }
    if (!agentEmailDomainOwnershipVerified(domain, answers)) {
      if (options.mode === "send-only") return false;
      throw new Error(`Email domain ${domain.domain} ownership TXT record is not verified.`);
    }
    return true;
  }

  function pendingOwnership(domain: AgentEmailDomainRecord): AgentEmailDomainRecord {
    const timestamp = now().toISOString();
    return {
      ...domain,
      failureReason: "Publish the ownership TXT record before provisioning this domain.",
      lastCheckedAt: timestamp,
      status: "pending_dns",
      updatedAt: timestamp,
    };
  }

  async function provisioningContext(
    domain: AgentEmailDomainRecord,
    requirements: {
      readonly activePlacement?: boolean;
      readonly configurationSet?: boolean;
    } = { activePlacement: true, configurationSet: true },
  ): Promise<ProvisioningContext> {
    if (!domain.placementId) {
      return {
        ...(options.defaultConfigurationSetName
          ? { configurationSetName: options.defaultConfigurationSetName }
          : {}),
        primaryRegion: options.defaultRegion,
      };
    }
    if (!options.getPlacement) {
      throw new Error("Agent email placement lookup is required for placed domains.");
    }
    const placement = await options.getPlacement(domain.organizationId, domain.placementId);
    if (!placement) {
      throw new Error(`Email placement ${domain.placementId} does not exist.`);
    }
    if (
      options.mode !== "send-only" &&
      !domain.providerManaged &&
      placement.region !== options.defaultRegion
    ) {
      throw new Error(
        `Custom email domain placements must use inbound receipt region ${options.defaultRegion}.`,
      );
    }
    if (requirements.activePlacement !== false && placement.status !== "active") {
      throw new Error(`Email placement ${domain.placementId} is not active.`);
    }
    const configurationSetName = placement.providerMetadata.configurationSetName;
    if (
      requirements.configurationSet !== false &&
      (typeof configurationSetName !== "string" || !configurationSetName)
    ) {
      throw new Error(`Email placement ${placement.id} has no configuration set.`);
    }
    return {
      ...(typeof configurationSetName === "string" && configurationSetName
        ? { configurationSetName }
        : {}),
      primaryRegion: placement.region,
      ...(placement.secondaryRegion ? { secondaryRegion: placement.secondaryRegion } : {}),
    };
  }

  function identityArn(region: string, domain: AgentEmailDomainRecord) {
    return `arn:${options.partition ?? "aws"}:ses:${region}:${options.accountId}:identity/${domain.domain}`;
  }

  async function ownsIdentity(domain: AgentEmailDomainRecord, region: string) {
    const tags = await operationsForRegion(region).listTags(identityArn(region, domain));
    return agentEmailIdentityTagsMatch(domain, tags);
  }

  async function requireOwnedIdentity(
    domain: AgentEmailDomainRecord,
    region: string,
    allowMissing = false,
  ) {
    try {
      if (await ownsIdentity(domain, region)) return true;
    } catch (cause) {
      if (allowMissing && notFound(cause)) return false;
      throw cause;
    }
    throw new AgentEmailDomainIdentityOwnershipError(domain.domain);
  }

  async function ensureIdentity(
    domain: AgentEmailDomainRecord,
    context: {
      readonly configurationSetName?: string;
      readonly parentRegion?: string;
      readonly region: string;
    },
  ) {
    try {
      await operationsForRegion(context.region).createIdentity({
        ...(context.configurationSetName
          ? { ConfigurationSetName: context.configurationSetName }
          : {}),
        ...(context.parentRegion
          ? {
              DkimSigningAttributes: {
                DomainSigningAttributesOrigin: agentEmailDeterministicDkimOrigin(
                  context.parentRegion,
                ),
              },
            }
          : {}),
        EmailIdentity: domain.domain,
        Tags: [
          { Key: "agent-inboxes:organization-id", Value: domain.organizationId },
          { Key: "agent-inboxes:resource-id", Value: domain.id },
        ],
      });
      return true;
    } catch (cause) {
      if (!alreadyExists(cause)) throw cause;
      if (!(await ownsIdentity(domain, context.region))) {
        throw new AgentEmailDomainIdentityOwnershipError(domain.domain);
      }
      return false;
    }
  }

  async function cleanupCreatedIdentities(
    domain: AgentEmailDomainRecord,
    regions: readonly string[],
    cause: unknown,
  ): Promise<never> {
    const cleanupErrors: unknown[] = [];
    for (const region of regions.toReversed()) {
      try {
        if (!(await requireOwnedIdentity(domain, region, true))) continue;
      } catch (cleanupCause) {
        cleanupErrors.push(cleanupCause);
        continue;
      }
      try {
        await operationsForRegion(region).dissociateTenantResource(
          tenantName(domain.organizationId),
          identityArn(region, domain),
        );
      } catch (cleanupCause) {
        if (!notFound(cleanupCause)) cleanupErrors.push(cleanupCause);
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Cleanup follows reverse creation order.
        await operationsForRegion(region).deleteIdentity(domain.domain);
      } catch (cleanupCause) {
        cleanupErrors.push(cleanupCause);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupErrors],
        `Failed to provision and clean up Amazon SES identity ${domain.domain}.`,
        { cause },
      );
    }
    throw cause;
  }

  async function provision(domain: AgentEmailDomainRecord) {
    if (domain.status === "revoked")
      throw new Error("Revoked email domains cannot be provisioned.");
    if (options.mode === "send-only" && domain.providerManaged) {
      throw new Error("Send-only domains require record-owned identities.");
    }
    if (domain.providerManaged) return readHostedIdentity(domain);
    if (!(await requireDomainOwnership(domain))) return pendingOwnership(domain);
    const context = await provisioningContext(domain);
    const createdRegions: string[] = [];
    let candidate: AgentEmailDomainRecord;
    try {
      if (
        await ensureIdentity(domain, {
          ...(context.configurationSetName
            ? { configurationSetName: context.configurationSetName }
            : {}),
          region: context.primaryRegion,
        })
      ) {
        createdRegions.push(context.primaryRegion);
      }
      await operationsForRegion(context.primaryRegion).putMailFrom(
        domain.domain,
        domain.mailFromDomain,
      );
      if (
        context.secondaryRegion &&
        (await ensureIdentity(domain, {
          ...(context.configurationSetName
            ? { configurationSetName: context.configurationSetName }
            : {}),
          parentRegion: context.primaryRegion,
          region: context.secondaryRegion,
        }))
      ) {
        createdRegions.push(context.secondaryRegion);
      }
      if (context.secondaryRegion) {
        await operationsForRegion(context.secondaryRegion).putMailFrom(
          domain.domain,
          agentEmailRegionalMailFromDomain(domain, context.secondaryRegion),
        );
      }
      const primaryIdentity = await operationsForRegion(context.primaryRegion).getIdentity(
        domain.domain,
      );
      const secondaryIdentity = context.secondaryRegion
        ? await operationsForRegion(context.secondaryRegion).getIdentity(domain.domain)
        : undefined;
      await Promise.all(
        [context.primaryRegion, ...(context.secondaryRegion ? [context.secondaryRegion] : [])].map(
          (region) =>
            operationsForRegion(region).associateTenantResource(
              tenantName(domain.organizationId),
              identityArn(region, domain),
            ),
        ),
      );
      candidate = agentEmailDomainIdentityState(domain, primaryIdentity, {
        ...(options.mode ? { mode: options.mode } : {}),
        now: now(),
        region: context.primaryRegion,
        ...(context.secondaryRegion && secondaryIdentity
          ? { secondary: { identity: secondaryIdentity, region: context.secondaryRegion } }
          : {}),
      });
    } catch (cause) {
      return cleanupCreatedIdentities(domain, createdRegions, cause);
    }
    return requireInboundRouting(domain, candidate);
  }

  async function refresh(domain: AgentEmailDomainRecord) {
    if (domain.status === "revoked") throw new Error("Revoked email domains cannot be refreshed.");
    if (options.mode === "send-only" && domain.providerManaged) {
      throw new Error("Send-only domains require record-owned identities.");
    }
    if (domain.providerManaged) return readHostedIdentity(domain);
    if (options.mode === "send-only" && !(await requireDomainOwnership(domain))) {
      return pendingOwnership(domain);
    }
    const context = await provisioningContext(domain);
    const regions = [
      context.primaryRegion,
      ...(context.secondaryRegion ? [context.secondaryRegion] : []),
    ];
    try {
      await Promise.all(regions.map((region) => requireOwnedIdentity(domain, region)));
      const primaryIdentity = await operationsForRegion(context.primaryRegion).getIdentity(
        domain.domain,
      );
      const secondaryIdentity = context.secondaryRegion
        ? await operationsForRegion(context.secondaryRegion).getIdentity(domain.domain)
        : undefined;
      await Promise.all(
        regions.map((region) =>
          operationsForRegion(region).associateTenantResource(
            tenantName(domain.organizationId),
            identityArn(region, domain),
          ),
        ),
      );
      return requireInboundRouting(
        domain,
        agentEmailDomainIdentityState(domain, primaryIdentity, {
          ...(options.mode ? { mode: options.mode } : {}),
          now: now(),
          region: context.primaryRegion,
          ...(context.secondaryRegion && secondaryIdentity
            ? { secondary: { identity: secondaryIdentity, region: context.secondaryRegion } }
            : {}),
        }),
      );
    } catch (cause) {
      if (notFound(cause)) throw new AgentEmailDomainIdentityMissingError(domain.domain, { cause });
      throw cause;
    }
  }

  async function revoke(domain: AgentEmailDomainRecord) {
    if (domain.status === "revoked" && options.mode !== "send-only") {
      throw new Error("Email domain is already revoked.");
    }
    if (domain.providerManaged) {
      requireHostedDomain(domain);
      throw new Error("OpenTofu-managed hosted email domains cannot be revoked.");
    }
    const context = await provisioningContext(domain, {
      activePlacement: false,
      configurationSet: false,
    });
    const deletableRegions: string[] = [];
    for (const region of [
      context.primaryRegion,
      ...(context.secondaryRegion ? [context.secondaryRegion] : []),
    ]) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Ownership is checked independently per region.
        if (await requireOwnedIdentity(domain, region, true)) deletableRegions.push(region);
      } catch (cause) {
        if (!(cause instanceof AgentEmailDomainIdentityOwnershipError)) throw cause;
      }
    }
    return revokeAgentEmailDomainIdentity(domain, {
      deleteIdentity: async () => {
        for (const region of deletableRegions) {
          try {
            // eslint-disable-next-line no-await-in-loop -- All tenant associations are removed before identity deletion.
            await operationsForRegion(region).dissociateTenantResource(
              tenantName(domain.organizationId),
              identityArn(region, domain),
            );
          } catch (cause) {
            if (!notFound(cause)) throw cause;
          }
        }
        for (const region of deletableRegions.toReversed()) {
          // eslint-disable-next-line no-await-in-loop -- Identity deletion follows complete dissociation.
          await operationsForRegion(region).deleteIdentity(domain.domain);
        }
      },
      identityExistsAndIsOwned: async () => deletableRegions.length > 0,
      now,
    });
  }

  return { provision, refresh, revoke };
}
