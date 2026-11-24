import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { DynamoDatabaseService } from "./client-types.ts";
import { makeIdGenerator, Ulid, type Ulid as UlidValue } from "./ids.ts";
import { key } from "./keys.ts";
import { InboundThreadRouteRecord, type IngressSourceKind } from "./records/execution.ts";
import { type PlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import { readThreadTombstone } from "./thread-erasure/requests.ts";

const MAX_ROUTE_RESERVATION_ATTEMPTS = 3;

type AgentDeployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
type AgentRelease = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
type ChannelBinding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;
type Environment = Extract<PlatformRecord, { readonly itemType: "environment" }>;

export interface InboundRecordScope {
  readonly environmentId: UlidValue;
  readonly organizationId: UlidValue;
}

export interface InboundEnvironmentScope extends InboundRecordScope {
  readonly projectId: UlidValue;
}

export interface InboundThreadRouteInput extends InboundRecordScope {
  readonly agentDeploymentId: UlidValue;
  readonly channel: string;
  readonly createdAt: string;
  readonly externalAccountId?: string;
  readonly externalChannelId: string;
  readonly externalThreadKey: string;
  readonly externalWorkspaceId?: string;
  readonly ingressRouteId?: string;
  readonly projectId: UlidValue;
  readonly provider: string;
  readonly sourceId: UlidValue;
  readonly sourceKind: IngressSourceKind;
}

export interface InboundPersistence {
  loadAgentDeployment(
    scope: InboundRecordScope,
    deploymentId: UlidValue,
  ): Promise<AgentDeployment | undefined>;
  loadAgentRelease(
    scope: InboundRecordScope,
    releaseId: UlidValue,
  ): Promise<AgentRelease | undefined>;
  loadEnvironment(scope: InboundEnvironmentScope): Promise<Environment | undefined>;
  loadChannelBinding(
    scope: InboundRecordScope,
    bindingId: UlidValue,
  ): Promise<ChannelBinding | undefined>;
  reserveThreadRoute(input: InboundThreadRouteInput): Promise<UlidValue>;
}

export interface InboundPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<string>;
}

function routeIdentity(input: InboundThreadRouteInput) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.sourceKind,
        input.agentDeploymentId,
        input.provider,
        input.channel,
        input.externalAccountId ?? "",
        input.externalWorkspaceId ?? "",
        input.externalChannelId,
        input.externalThreadKey,
      ]),
    )
    .digest("hex");
}

function routeKey(input: InboundThreadRouteInput, routeId: string) {
  return {
    pk: key("ORG", input.organizationId, "SOURCE", input.sourceId),
    sk: key("INBOUND-THREAD-ROUTE", routeId),
  };
}

function validatedRouteThreadId(
  record: PlatformRecord,
  input: InboundThreadRouteInput,
  routeId: string,
) {
  if (
    record.itemType !== "inbound-thread-route" ||
    record.data.id !== routeId ||
    record.data.sourceKind !== input.sourceKind ||
    record.data.sourceId !== input.sourceId ||
    record.data.agentDeploymentId !== input.agentDeploymentId ||
    record.data.provider !== input.provider ||
    record.data.channel !== input.channel ||
    record.data.externalAccountId !== input.externalAccountId ||
    record.data.externalWorkspaceId !== input.externalWorkspaceId ||
    record.data.externalChannelId !== input.externalChannelId ||
    record.data.externalThreadKey !== input.externalThreadKey ||
    record.data.organizationId !== input.organizationId ||
    record.data.projectId !== input.projectId ||
    record.data.environmentId !== input.environmentId
  ) {
    throw new Error("Inbound thread route does not match the requested external identity.");
  }
  return record.data.threadId;
}

export function makeInboundPersistence(
  dependencies: InboundPersistenceDependencies,
): InboundPersistence {
  const idGenerator = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => idGenerator.generate());

  function loadRecord(
    table: "control" | "execution",
    recordKey: { readonly pk: string; readonly sk: string },
  ) {
    return dependencies.database.getRecord(table, recordKey, true);
  }

  return {
    async loadAgentDeployment(scope, deploymentId) {
      const value = await loadRecord("control", {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("AGENT-DEPLOYMENT", deploymentId),
      });
      return value?.itemType === "agent-deployment" ? value : undefined;
    },

    async loadAgentRelease(scope, releaseId) {
      const value = await loadRecord("control", {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("AGENT-RELEASE", releaseId),
      });
      return value?.itemType === "agent-release" ? value : undefined;
    },

    async loadEnvironment(scope) {
      const value = await loadRecord("control", {
        pk: key("ORG", scope.organizationId, "PROJECT", scope.projectId),
        sk: key("ENVIRONMENT", scope.environmentId),
      });
      return value?.itemType === "environment" ? value : undefined;
    },

    async loadChannelBinding(scope, bindingId) {
      const value = await loadRecord("control", {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("CHANNEL-BINDING", bindingId),
      });
      return value?.itemType === "channel-binding" ? value : undefined;
    },

    async reserveThreadRoute(input) {
      const routeId = routeIdentity(input);
      const recordKey = routeKey(input, routeId);
      for (let attempt = 1; ; attempt += 1) {
        const existing = await loadRecord("execution", recordKey);
        if (existing) {
          const threadId = validatedRouteThreadId(existing, input, routeId);
          if (!(await readThreadTombstone(dependencies.database, input.organizationId, threadId))) {
            return threadId;
          }
          try {
            await dependencies.database.transactWrite([{ kind: "delete", record: existing }]);
          } catch (cause) {
            if (attempt >= MAX_ROUTE_RESERVATION_ATTEMPTS) throw cause;
            continue;
          }
        }

        const threadId = Schema.decodeUnknownSync(Ulid)(await generateId());
        const route = Schema.decodeUnknownSync(InboundThreadRouteRecord)(
          withCanonicalRecordKeys({
            data: {
              agentDeploymentId: input.agentDeploymentId,
              channel: input.channel,
              createdAt: input.createdAt,
              environmentId: input.environmentId,
              ...(input.externalAccountId ? { externalAccountId: input.externalAccountId } : {}),
              externalChannelId: input.externalChannelId,
              externalThreadKey: input.externalThreadKey,
              ...(input.externalWorkspaceId
                ? { externalWorkspaceId: input.externalWorkspaceId }
                : {}),
              id: routeId,
              ...(input.ingressRouteId ? { ingressRouteId: input.ingressRouteId } : {}),
              organizationId: input.organizationId,
              projectId: input.projectId,
              provider: input.provider,
              sourceId: input.sourceId,
              sourceKind: input.sourceKind,
              threadId,
            },
            itemType: "inbound-thread-route" as const,
          }),
        );

        try {
          await dependencies.database.putRecord(
            route,
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          );
          return threadId;
        } catch (cause) {
          if (attempt >= MAX_ROUTE_RESERVATION_ATTEMPTS) throw cause;
        }
      }
    },
  };
}
