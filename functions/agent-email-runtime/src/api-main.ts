import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  buildAgentEmailDomainEvent,
  type AgentEmailDomainRecord,
  type AgentEmailPlacementRecord,
  type AgentEmailProviderTenantRecord,
} from "@deployments-ai/agent-email";
import {
  agentEmailSesConfigurationSetArn,
  agentEmailSesIdentityArn,
  agentEmailSesTenantName,
  deterministicAgentEmailUlid,
  makeAgentEmailAwsRuntime,
  makeAgentEmailSesDomainProvisioner,
  productionAgentEmailPlacementProvisioner,
  reconcileAgentEmailSesTenant,
} from "@deployments-ai/agent-email/aws";
import { agentManifestAllowsTrigger } from "@deployments-ai/agent-manifest";
import {
  createApplicationAuthenticator,
  OperatorAccessRequiredError,
  OrganizationSsoRequiredError,
  type ApiIdentity,
} from "@deployments-ai/api";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import {
  createApiCredentialUsageRecorder,
  makeAgentEmailDynamoRepository,
  makeAgentEmailRepositoryContext,
  makeDynamoDatabase,
  makeIdempotencyPersistence,
  makeInboundPersistence,
  makeKmsIdempotencyResponseProtector,
  tableNamesFromEnvironment,
  type InboundPersistence,
  type PlatformRecord,
} from "@deployments-ai/db";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeOrganizationGateFromEnvironment } from "@deployments-ai/organization-admission";
import { Effect } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AgentEmailApiError,
  createAgentEmailApiHandler,
  type AgentEmailApiIdentity,
  type AgentEmailApiInvocation,
  type AgentEmailApiOperation,
  type AgentEmailApiScope,
  type AgentEmailHttpEvent,
  type AgentEmailHttpResult,
  type AgentEmailIdempotencyStore,
} from "./api-handler.ts";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";
import { placementFrom } from "./application-service-support.ts";
import { syncAgentEmailMessageSuppression } from "./suppression-runtime.ts";
import { legacyAgentEmailBuckets } from "./legacy-buckets.ts";
import { isEmailApiOperation } from "./api-routes.ts";
import { createEmailApplicationService } from "./email-application-service.ts";
import { makeEmailProviderRuntime } from "./email-provider-runtime.ts";

const AGENT_EMAIL_API_ENV = {
  bucket: "DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET",
  configurationSet: "DEPLOYMENTS_AI_AGENT_EMAIL_CONFIGURATION_SET",
  accountId: "DEPLOYMENTS_AI_AWS_ACCOUNT_ID",
  eventsQueueUrl: "DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL",
  idempotencyKmsKeyArn: "DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN",
  inboundQueueUrl: "DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_QUEUE_URL",
  inboundReady: "DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_READY",
  jwtAudience: "DEPLOYMENTS_AI_API_JWT_AUDIENCE",
  jwtClaimProfile: "DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE",
  jwtIssuer: "DEPLOYMENTS_AI_API_JWT_ISSUER",
  jwksUri: "DEPLOYMENTS_AI_API_JWKS_URI",
  sendQueueUrl: "DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL",
  hostedDomain: "DEPLOYMENTS_AI_AGENT_EMAIL_HOSTED_DOMAIN",
  endUserSubjectKeyArn: "DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN",
} as const;

/** Project domain lists are unbounded, so per-domain consistent re-reads are throttled. */
const DOMAIN_REREAD_CONCURRENCY = 8;

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function jwtAudience(value: string): string | string[] {
  if (!value.startsWith("[")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${AGENT_EMAIL_API_ENV.jwtAudience} must be a JSON string array.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((entry) => typeof entry === "string" && entry.trim())
  ) {
    throw new Error(`${AGENT_EMAIL_API_ENV.jwtAudience} must be a non-empty JSON string array.`);
  }
  return parsed;
}

function jwtClaimProfile(environment: NodeJS.ProcessEnv) {
  const value = environment[AGENT_EMAIL_API_ENV.jwtClaimProfile]?.trim() || "auto";
  if (value === "auto") return undefined;
  if (value === "cognito" || value === "legacy" || value === "platform") return value;
  throw new Error(
    `${AGENT_EMAIL_API_ENV.jwtClaimProfile} must be auto, cognito, legacy, or platform.`,
  );
}

function exactlyOne(values: readonly string[] | "*" | undefined) {
  return values !== "*" && values?.length === 1 ? values[0] : undefined;
}

export function agentEmailIdentityFromApiIdentity(
  identity: ApiIdentity | null | undefined,
): AgentEmailApiIdentity | null {
  if (!identity) return null;
  const organizationId = exactlyOne(identity.organizationIds);
  const projectId = exactlyOne(identity.projectIds);
  const environmentId = exactlyOne(identity.environmentIds);
  if (!organizationId || !projectId || !environmentId) return null;
  return {
    ...(identity.apiCredentialId ? { apiCredentialId: identity.apiCredentialId } : {}),
    ...(identity.authentication ? { authentication: identity.authentication } : {}),
    permissions: identity.scopes,
    principalId: identity.principalId,
    scope: { environmentId, organizationId, projectId },
  };
}

export async function validateAgentEmailDeployment(
  scope: AgentEmailApiScope,
  agentDeploymentId: string,
  persistence: Pick<InboundPersistence, "loadAgentDeployment" | "loadAgentRelease">,
) {
  const recordScope = {
    environmentId: scope.environmentId as never,
    organizationId: scope.organizationId as never,
  };
  const deployment = await persistence.loadAgentDeployment(recordScope, agentDeploymentId as never);
  if (
    !deployment ||
    deployment.data.organizationId !== scope.organizationId ||
    deployment.data.projectId !== scope.projectId ||
    deployment.data.environmentId !== scope.environmentId ||
    deployment.data.id !== agentDeploymentId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    return undefined;
  }
  const release = await persistence.loadAgentRelease(recordScope, deployment.data.agentReleaseId);
  return release?.data.organizationId === scope.organizationId &&
    release.data.projectId === scope.projectId &&
    release.data.environmentId === scope.environmentId &&
    release.data.id === deployment.data.agentReleaseId &&
    release.data.agentDefinitionId === deployment.data.agentDefinitionId &&
    release.data.status === "active" &&
    agentManifestAllowsTrigger(release.data.manifest, "email")
    ? { agentDefinitionId: deployment.data.agentDefinitionId }
    : undefined;
}

export function assertAgentEmailEnvironmentActive(
  environmentRecord: Extract<PlatformRecord, { readonly itemType: "environment" }> | undefined,
  scope: AgentEmailApiScope,
) {
  if (
    environmentRecord?.data.organizationId !== scope.organizationId ||
    environmentRecord.data.projectId !== scope.projectId ||
    environmentRecord.data.id !== scope.environmentId ||
    environmentRecord.data.status !== "active"
  ) {
    throw new AgentEmailApiError(
      409,
      "environment_not_active",
      "Agent email is unavailable for an inactive environment.",
    );
  }
}

function webRequest(event: AgentEmailHttpEvent) {
  return new Request(`https://api.us.deployments.ai${event.rawPath}`, {
    headers: Object.fromEntries(
      Object.entries(event.headers ?? {}).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    ),
    method: event.requestContext?.http?.method ?? "GET",
  });
}

export function hostedAgentEmailDomainSeed(
  scope: AgentEmailApiScope,
  hostedDomain: string,
  timestamp: string,
): AgentEmailDomainRecord {
  const domain = hostedDomain.trim().toLowerCase().replace(/\.$/u, "");
  return {
    createdAt: timestamp,
    dnsRecords: [],
    domain,
    id: deterministicAgentEmailUlid(
      "1970-01-01T00:00:00.000Z",
      "hosted-domain-v1",
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      domain,
    ),
    mailFromDomain: `bounce.${domain}`,
    organizationId: scope.organizationId,
    providerManaged: true,
    providerMetadata: {},
    status: "pending",
    updatedAt: timestamp,
  };
}

export function agentEmailTenantIdentityResources(input: {
  readonly accountId: string;
  readonly domains: readonly Extract<PlatformRecord, { readonly itemType: "inbox-domain" }>[];
  readonly mode: "associate" | "dissociate" | "prepare";
  readonly placement: AgentEmailPlacementRecord;
  readonly placements: readonly Extract<PlatformRecord, { readonly itemType: "inbox-placement" }>[];
  readonly region: string;
  readonly tenantRegion: string;
}) {
  return input.domains.flatMap((domain) => {
    // The OpenTofu-managed hosted identity is shared by every organization,
    // while an SES identity can belong to only one tenant. Hosted-domain sends
    // therefore use account-level SES sending; custom identities remain tenant-isolated.
    if (domain.data.status !== "verified" || domain.data.providerManaged) return [];
    const domainPlacement = domain.data.placementId
      ? input.placements.find((candidate) => candidate.data.id === domain.data.placementId)
      : undefined;
    const placementSupportsRegion =
      input.placement.region === input.tenantRegion ||
      input.placement.secondaryRegion === input.tenantRegion;
    const belongsToCurrent =
      domain.data.placementId === input.placement.id ||
      (!domain.data.placementId &&
        input.placement.isDefault &&
        input.tenantRegion === input.region);
    const belongsToActivePlacement = domainPlacement
      ? domainPlacement.data.status === "active" &&
        (domainPlacement.data.region === input.tenantRegion ||
          domainPlacement.data.secondaryRegion === input.tenantRegion)
      : input.placements.some(
          (candidate) =>
            candidate.data.isDefault &&
            candidate.data.status === "active" &&
            candidate.data.region === input.tenantRegion,
        ) && input.tenantRegion === input.region;
    const shouldAssociate =
      (belongsToCurrent && input.mode !== "dissociate" && placementSupportsRegion) ||
      (!belongsToCurrent && belongsToActivePlacement);
    return shouldAssociate
      ? [agentEmailSesIdentityArn(input.tenantRegion, input.accountId, domain.data.domain)]
      : [];
  });
}

export function agentEmailPlacementIdentityResources(input: {
  readonly accountId: string;
  readonly domains: readonly Extract<PlatformRecord, { readonly itemType: "inbox-domain" }>[];
  readonly placement: AgentEmailPlacementRecord;
  readonly tenantRegion: string;
}) {
  const placementSupportsRegion =
    input.placement.region === input.tenantRegion ||
    input.placement.secondaryRegion === input.tenantRegion;
  if (!placementSupportsRegion) return [];
  return input.domains.flatMap((domain) => {
    if (domain.data.providerManaged) return [];
    const belongsToPlacement =
      domain.data.placementId === input.placement.id ||
      (!domain.data.placementId && input.placement.isDefault);
    return belongsToPlacement
      ? [agentEmailSesIdentityArn(input.tenantRegion, input.accountId, domain.data.domain)]
      : [];
  });
}

export async function persistHostedDomainBeforeTenantReconciliation(input: {
  readonly create: () => Promise<void>;
  readonly loadCommitted: () => Promise<unknown>;
  readonly reconcile: () => Promise<void>;
}) {
  try {
    await input.create();
  } catch (cause) {
    if (!(await input.loadCommitted())) throw cause;
  }
  await input.reconcile();
}

async function createAgentEmailApiLambdaRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(environment));
  const endUserKeys = endUserKeyDeriver(
    await loadAwsSecretString(
      requiredEnvironment(environment, AGENT_EMAIL_API_ENV.endUserSubjectKeyArn),
    ),
  );
  const issuer = requiredEnvironment(environment, AGENT_EMAIL_API_ENV.jwtIssuer);
  const claimProfile = jwtClaimProfile(environment);
  const authenticateApplication = createApplicationAuthenticator({
    database,
    jwt: {
      audience: jwtAudience(requiredEnvironment(environment, AGENT_EMAIL_API_ENV.jwtAudience)),
      ...(claimProfile ? { claimProfile } : {}),
      issuer,
      ...(environment[AGENT_EMAIL_API_ENV.jwksUri]?.trim()
        ? { jwksUri: environment[AGENT_EMAIL_API_ENV.jwksUri]!.trim() }
        : {}),
    },
  });
  const region = requiredEnvironment(environment, "AWS_REGION");
  const accountId = requiredEnvironment(environment, AGENT_EMAIL_API_ENV.accountId);
  const hostedDomain = requiredEnvironment(environment, AGENT_EMAIL_API_ENV.hostedDomain)
    .toLowerCase()
    .replace(/\.$/u, "");
  const inboundQueueUrl = requiredEnvironment(environment, AGENT_EMAIL_API_ENV.inboundQueueUrl);
  const aws = makeAgentEmailAwsRuntime({
    bucket: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.bucket),
    configurationSetName: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.configurationSet),
    eventsQueueUrl: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.eventsQueueUrl),
    legacyBuckets: legacyAgentEmailBuckets(environment),
    region,
    sendQueueUrl: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.sendQueueUrl),
    tenantName: "agent-email-api-control-plane",
  });
  const invocationScope = new AsyncLocalStorage<AgentEmailApiScope>();
  const reconcilePlacementTenants = async (
    placement: AgentEmailPlacementRecord,
    mode: "associate" | "dissociate" | "prepare",
  ) => {
    const scope = invocationScope.getStore();
    if (!scope || scope.organizationId !== placement.organizationId) {
      throw new Error("Agent email tenant provisioning requires the active API scope.");
    }
    const repository = makeAgentEmailDynamoRepository(database, {
      environmentId: scope.environmentId as never,
      organizationId: scope.organizationId as never,
      projectId: scope.projectId as never,
    });
    const configurationSetName =
      typeof placement.providerMetadata.configurationSetName === "string"
        ? placement.providerMetadata.configurationSetName
        : undefined;
    const regions = [
      placement.region,
      ...(placement.secondaryRegion ? [placement.secondaryRegion] : []),
    ];
    let tenants = await repository.listProviderTenants();
    const [domains, placements, currentDomainCandidates] = await Promise.all([
      repository.listOrganizationDomains(),
      repository.listOrganizationPlacements(),
      repository.listDomains(),
    ]);
    const currentDomains = (
      await Effect.runPromise(
        Effect.forEach(
          currentDomainCandidates,
          (domain) =>
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () => repository.getDomain(domain.data.id),
            }),
          { concurrency: DOMAIN_REREAD_CONCURRENCY },
        ),
      )
    ).filter(
      (domain): domain is Extract<PlatformRecord, { readonly itemType: "inbox-domain" }> =>
        domain !== undefined,
    );
    for (const tenantRegion of regions) {
      let persisted = tenants.find(
        (tenant) => tenant.data.provider === "ses" && tenant.data.region === tenantRegion,
      );
      if (!persisted) {
        const timestamp = new Date().toISOString();
        persisted = await repository.createProviderTenant({
          createdAt: timestamp,
          id: deterministicAgentEmailUlid(
            "1970-01-01T00:00:00.000Z",
            "provider-tenant-v1",
            placement.organizationId,
            tenantRegion,
          ),
          organizationId: placement.organizationId,
          provider: "ses",
          providerMetadata: {},
          providerName: agentEmailSesTenantName(placement.organizationId),
          region: tenantRegion,
          sendingStatus: "provisioning",
          suppressedReasons: ["bounce", "complaint"],
          suppressionScope: "tenant",
          updatedAt: timestamp,
        });
        tenants = [...tenants, persisted];
      }
      const { version: _version, ...tenantData } = persisted.data;
      const placementResource =
        configurationSetName === undefined
          ? undefined
          : agentEmailSesConfigurationSetArn(tenantRegion, accountId, configurationSetName);
      const identityResources = agentEmailTenantIdentityResources({
        accountId,
        domains,
        mode,
        placement,
        placements,
        region,
        tenantRegion,
      });
      const placementIdentityResources = agentEmailPlacementIdentityResources({
        accountId,
        domains: currentDomains,
        placement,
        tenantRegion,
      });
      const resourceArns =
        mode === "associate" && placementResource
          ? [...new Set([placementResource, ...identityResources])]
          : [...new Set(identityResources)];
      const reconciled = await reconcileAgentEmailSesTenant(
        tenantData as AgentEmailProviderTenantRecord,
        {
          localSendingStatus: "active",
          ...(mode === "dissociate"
            ? {
                removeResourceArns: [
                  ...(placementResource ? [placementResource] : []),
                  ...placementIdentityResources,
                ],
              }
            : {}),
          resourceArns,
        },
      );
      await repository.updateProviderTenant(reconciled);
    }
  };
  const placementProvisioner = {
    deprovision: async (placement: AgentEmailPlacementRecord) => {
      const disabled = await productionAgentEmailPlacementProvisioner.deprovision(placement);
      await reconcilePlacementTenants(placement, "dissociate");
      return disabled;
    },
    prepareReservation: (placement: AgentEmailPlacementRecord) =>
      productionAgentEmailPlacementProvisioner.prepareReservation(placement),
    provision: async (placement: AgentEmailPlacementRecord) => {
      await reconcilePlacementTenants(placement, "prepare");
      const provisioned = await productionAgentEmailPlacementProvisioner.provision(placement);
      await reconcilePlacementTenants(provisioned, "associate");
      return provisioned;
    },
    reconcile: async (placement: AgentEmailPlacementRecord) => {
      await reconcilePlacementTenants(placement, "prepare");
      const reconciled = await productionAgentEmailPlacementProvisioner.reconcile(placement);
      await reconcilePlacementTenants(reconciled, "associate");
      return reconciled;
    },
  };
  const domainProvisioner = makeAgentEmailSesDomainProvisioner({
    accountId,
    defaultConfigurationSetName: requiredEnvironment(
      environment,
      AGENT_EMAIL_API_ENV.configurationSet,
    ),
    defaultRegion: region,
    getPlacement: async (organizationId, placementId) => {
      const scope = invocationScope.getStore();
      if (!scope || scope.organizationId !== organizationId) return undefined;
      const context = makeAgentEmailRepositoryContext(database, {
        environmentId: scope.environmentId as never,
        organizationId: scope.organizationId as never,
        projectId: scope.projectId as never,
      });
      const value = await context.getEnvironmentRecord("inbox-placement", placementId);
      return value?.itemType === "inbox-placement" ? placementFrom(value) : undefined;
    },
    hostedDomain,
    inboundReady: async () =>
      environment[AGENT_EMAIL_API_ENV.inboundReady]?.trim().toLowerCase() === "true",
  });
  const inboundPersistence = makeInboundPersistence({ database });
  const baseService = createDynamoAgentEmailApplicationService({
    blobBucket: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.bucket),
    blobs: aws.blobs,
    database,
    endUserKeys,
    defaultDomainId: async (scope, domains) => {
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: scope.environmentId as never,
        organizationId: scope.organizationId as never,
        projectId: scope.projectId as never,
      });
      const reconcileHostedDomainTenant = async () => {
        const defaults = (await repository.listPlacements()).filter(
          (placement) => placement.data.isDefault && placement.data.status === "active",
        );
        if (defaults.length > 1) {
          throw new Error("Hosted email domain resolves more than one active default placement.");
        }
        if (defaults[0]) {
          await reconcilePlacementTenants(placementFrom(defaults[0]), "associate");
        }
      };
      const timestamp = new Date().toISOString();
      const existing = domains.find((domain) => domain.domain === hostedDomain);
      if (existing && !existing.providerManaged) {
        throw new Error(
          `Hosted email domain ${hostedDomain} is already registered as a custom domain.`,
        );
      }
      const eventFor = (
        domain: AgentEmailDomainRecord,
        eventType: "agent-email.domain-created" | "agent-email.domain-updated",
      ) =>
        buildAgentEmailDomainEvent({
          aggregateId: domain.id,
          eventId: deterministicAgentEmailUlid(
            timestamp,
            "hosted-domain-event-v1",
            eventType,
            scope.organizationId,
            scope.projectId,
            scope.environmentId,
            domain.id,
          ),
          eventType,
          payload: {
            context: {
              environmentId: scope.environmentId,
              projectId: scope.projectId,
            },
            occurredAt: timestamp,
            organizationId: scope.organizationId,
            resourceId: domain.id,
            resourceType: "domain",
            status: domain.status,
            version: 1,
          },
        });
      if (existing) {
        if (existing.status === "verified") {
          await reconcileHostedDomainTenant();
          return existing.id;
        }
        const refreshed = {
          ...(await domainProvisioner.refresh(existing)),
          updatedAt: timestamp,
        };
        const saved = await repository.updateDomain(
          refreshed,
          eventFor(refreshed, "agent-email.domain-updated"),
        );
        await reconcileHostedDomainTenant();
        return saved ? refreshed.id : undefined;
      }
      const seed = hostedAgentEmailDomainSeed(scope, hostedDomain, timestamp);
      const adopted = {
        ...(await domainProvisioner.refresh(seed)),
        updatedAt: timestamp,
      };
      await persistHostedDomainBeforeTenantReconciliation({
        create: async () => {
          await repository.createDomain(adopted, eventFor(adopted, "agent-email.domain-created"));
        },
        loadCommitted: () => repository.getDomain(adopted.id),
        reconcile: reconcileHostedDomainTenant,
      });
      return adopted.id;
    },
    domainProvisioner,
    enqueueReprocess: async ({ message, reprocessId, scope }) => {
      await aws.sqs.send(
        new SendMessageCommand({
          MessageBody: JSON.stringify({
            environmentId: scope.environmentId,
            inboxId: message.inboxId,
            messageId: message.id,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            reprocessId,
            type: "agent-email.reprocess",
            version: 1,
          }),
          QueueUrl: inboundQueueUrl,
        }),
      );
    },
    hostedDomainRegion: region,
    placementProvisioner,
    syncProviderSuppression: async ({ message, removed, scope, suppression }) => {
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: scope.environmentId as never,
        organizationId: scope.organizationId as never,
        projectId: scope.projectId as never,
      });
      if (suppression.reason !== "bounce" && suppression.reason !== "complaint") {
        throw new Error("Only provider-created suppressions can be synchronized with SES.");
      }
      await syncAgentEmailMessageSuppression(repository, {
        address: suppression.address,
        message,
        reason: suppression.reason,
        removed,
        suppressionId: suppression.id,
      });
    },
    validateAgentDeployment: (scope, agentDeploymentId) =>
      validateAgentEmailDeployment(scope, agentDeploymentId, inboundPersistence),
  });
  const emailService = createEmailApplicationService({
    database,
    providers: makeEmailProviderRuntime(accountId),
    region,
  });
  const service = {
    execute: async (operation: AgentEmailApiOperation, invocation: AgentEmailApiInvocation) => {
      const environmentRecord = await inboundPersistence.loadEnvironment({
        environmentId: invocation.scope.environmentId as never,
        organizationId: invocation.scope.organizationId as never,
        projectId: invocation.scope.projectId as never,
      });
      assertAgentEmailEnvironmentActive(environmentRecord, invocation.scope);
      if (isEmailApiOperation(operation)) return emailService.execute(operation, invocation);
      return invocationScope.run(invocation.scope, () =>
        baseService.execute(operation, invocation),
      );
    },
  };
  const idempotency = makeIdempotencyPersistence({
    database,
    responseProtector: makeKmsIdempotencyResponseProtector({
      kmsKeyArn: requiredEnvironment(environment, AGENT_EMAIL_API_ENV.idempotencyKmsKeyArn),
    }),
  });
  const idempotencyStore: AgentEmailIdempotencyStore = {
    async execute<T>(input: {
      readonly fingerprint: string;
      readonly key: string;
      readonly operation: () => Promise<T>;
      readonly organizationId: string;
      readonly principalId: string;
    }) {
      return (await idempotency.execute(input)) as T;
    },
  };
  return createAgentEmailApiHandler({
    authenticate: async (event) =>
      agentEmailIdentityFromApiIdentity(
        await authenticateApplication(webRequest(event)).catch((cause: unknown) => {
          if (cause instanceof OperatorAccessRequiredError) {
            throw new AgentEmailApiError(403, "operator_access_required", cause.message);
          }
          if (cause instanceof OrganizationSsoRequiredError) {
            throw new AgentEmailApiError(403, "organization_sso_required", cause.message);
          }
          throw cause;
        }),
      ),
    idempotency: idempotencyStore,
    organizationGate: makeOrganizationGateFromEnvironment({
      client: documentClient,
      database,
      environment,
    }),
    recordApiCredentialUsage: createApiCredentialUsageRecorder({ database }),
    service,
  });
}

let runtime: Promise<(event: AgentEmailHttpEvent) => Promise<AgentEmailHttpResult>> | undefined;

export async function handler(event: AgentEmailHttpEvent): Promise<AgentEmailHttpResult> {
  const resolved = await (runtime ??= createAgentEmailApiLambdaRuntime().catch((cause: unknown) => {
    runtime = undefined;
    throw cause;
  }));
  return resolved(event);
}
