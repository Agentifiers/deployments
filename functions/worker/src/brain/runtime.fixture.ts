import type {
  Brain,
  BrainDeploymentMount,
  BrainGrant,
  BrainQueryRuntime,
  BrainRepository,
} from "@deployments-ai/brains";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "@deployments-ai/tools";

export const ids = Array.from(
  { length: 16 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}`,
) as Ulid[];

export const [
  organizationId,
  projectId,
  environmentId,
  serviceAccountId,
  credentialId,
  definitionId,
  releaseId,
  deploymentId,
  runId,
  threadId,
  toolCallId,
  brainId,
] = ids as [Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid, Ulid];

export const now = "2026-07-31T12:00:00.000Z";

function platformRecord(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
  pk: string,
  sk: string,
) {
  return { data, itemType, pk, sk } as PlatformRecord;
}

export function records(
  initiatingCaller: Readonly<Record<string, unknown>> | undefined,
  workspaceId?: Ulid,
) {
  const partition = key("ORG", organizationId, "ENV", environmentId);
  const threadPartition = key("ORG", organizationId, "THREAD", threadId);
  const values = [
    platformRecord(
      "run-lookup",
      {
        createdAt: now,
        environmentId,
        idempotencyKey: "brain-run",
        organizationId,
        projectId,
        runId,
        threadId,
      },
      threadPartition,
      key("RUN-LOOKUP", runId),
    ),
    platformRecord(
      "run",
      {
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        environmentId,
        id: runId,
        idempotencyKey: "brain-run",
        ...(initiatingCaller ? { initiatingCaller } : {}),
        organizationId,
        projectId,
        status: "running",
        threadId,
        ...(workspaceId ? { workspaceId } : {}),
      },
      threadPartition,
      key("RUN", "brain-run"),
    ),
    platformRecord(
      "organization",
      { id: organizationId, status: "active" },
      key("ORG", organizationId),
      key("ORG", organizationId),
    ),
    platformRecord(
      "agent-definition",
      {
        environmentId,
        id: definitionId,
        organizationId,
        projectId,
        status: "active",
        version: 0,
        ...(workspaceId ? { workspaceId } : {}),
      },
      partition,
      key("AGENT-DEFINITION", definitionId),
    ),
    platformRecord(
      "agent-deployment",
      {
        agentDefinitionId: definitionId,
        agentReleaseId: releaseId,
        currentState: "ready",
        desiredState: "running",
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        version: 0,
      },
      partition,
      key("AGENT-DEPLOYMENT", deploymentId),
    ),
    platformRecord(
      "agent-release",
      {
        agentDefinitionId: definitionId,
        contentHash: "release-content-hash",
        environmentId,
        id: releaseId,
        manifest: {
          spec: {
            capabilities: {
              tools: [
                {
                  name: "agent.brain.search",
                  required: false,
                  requiredScopes: [],
                },
                {
                  name: "agent.brain.get_document",
                  required: false,
                  requiredScopes: [],
                },
                {
                  name: "agent.brain.get_entity",
                  required: false,
                  requiredScopes: [],
                },
                {
                  name: "agent.brain.capture",
                  required: false,
                  requiredScopes: [],
                },
              ],
            },
          },
        },
        organizationId,
        projectId,
        status: "active",
        version: 0,
      },
      partition,
      key("AGENT-RELEASE", releaseId),
    ),
    platformRecord(
      "service-account",
      {
        environmentId,
        id: serviceAccountId,
        organizationId,
        projectId,
        scopes: ["brains:read", "brains:write"],
        status: "active",
      },
      partition,
      key("SERVICE-ACCOUNT", serviceAccountId),
    ),
    platformRecord(
      "api-credential",
      {
        environmentId,
        id: credentialId,
        organizationId,
        projectId,
        scopes: ["brains:read", "brains:write"],
        serviceAccountId,
        status: "active",
      },
      partition,
      key("API-CREDENTIAL", credentialId),
    ),
  ];
  return new Map(values.map((value) => [`${value.pk}\n${value.sk}`, value]));
}

export function database(values: Map<string, PlatformRecord>): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: (_table, recordKey) =>
      Promise.resolve(
        values.has(`${recordKey.pk}\n${recordKey.sk}`)
          ? values.get(`${recordKey.pk}\n${recordKey.sk}`)!
          : undefined,
      ),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
}

const brain: Brain = {
  createdAt: now,
  createdByPrincipalId: ids[12]!,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Company knowledge",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-knowledge",
  status: "active",
  updatedAt: now,
  updatedByPrincipalId: ids[12]!,
  version: 0,
};

const serviceGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: now,
  grantedByPrincipalId: ids[12]!,
  id: ids[13]!,
  organizationId,
  permission: "read-write",
  status: "active",
  target: { environmentId, projectId, serviceAccountId, type: "service-account" },
  updatedAt: now,
  version: 0,
};

const agentGrant: BrainGrant = {
  ...serviceGrant,
  id: ids[14]!,
  target: { agentDefinitionId: definitionId, environmentId, projectId, type: "agent-definition" },
};

const mount: BrainDeploymentMount = {
  agentDefinitionId: definitionId,
  agentDeploymentId: deploymentId,
  brainId,
  brainKind: "company",
  createdAt: now,
  environmentId,
  grantedByPrincipalId: ids[12]!,
  id: ids[15]!,
  organizationId,
  permission: "read-write",
  projectId,
  status: "active",
  updatedAt: now,
  version: 0,
};

export function repository(state: {
  capture?: boolean;
  graph?: boolean;
  revoked: boolean;
}): BrainRepository {
  const partial: Partial<BrainRepository> &
    Pick<BrainRepository, "findActiveGrant" | "findActiveMount" | "get"> = {
    get: async (_organizationId, requestedBrainId) =>
      requestedBrainId === brainId ? brain : undefined,
    findActiveGrant: async (_organizationId, _brainId, target) => {
      if (state.revoked) return undefined;
      return target.type === "agent-definition" ? agentGrant : serviceGrant;
    },
    findActiveMount: async () => (state.revoked ? undefined : mount),
    listByOrganization: async () => ({ items: state.revoked ? [] : [brain] }),
    ...(state.capture
      ? {
          beginUpload: async ({ next }) => next,
          captureDocumentRevision: async ({ document, version }) => ({ document, version }),
          completeUpload: async ({ next }) => next,
          findDocumentBySourceIdentity: async () => undefined,
          findSourceRevisionClaim: async () => undefined,
          getDocument: async () => undefined,
          getDocumentVersion: async () => undefined,
          getSource: async () => ({
            brainId,
            createdAt: now,
            createdByPrincipalId: serviceAccountId,
            id: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
            kind: "upload" as const,
            name: "Agent captures",
            organizationId,
            status: "active" as const,
            updatedAt: now,
            updatedByPrincipalId: serviceAccountId,
            version: 0,
          }),
          issueUploadTicket: async ({ ticket }) => ticket,
        }
      : {}),
    ...(state.graph
      ? {
          getDocument: async () => ({
            brainId,
            createdAt: now,
            currentContentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
            externalItemIdentity: "decision",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
            lifecycle: "active" as const,
            organizationId,
            projectionGeneration: 1,
            reviewStatus: "approved" as const,
            sensitivity: "internal" as const,
            sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
            updatedAt: now,
            version: 0,
          }),
          getEntity: async () => ({
            brainId,
            canonicalName: "Acme",
            createdAt: now,
            externalIdentifiers: {},
            id: "01ARZ3NDEKTSV4RRFFQ69G5FBZ",
            kind: "company" as const,
            normalizedAliases: ["acme"],
            organizationId,
            reviewStatus: "approved" as const,
            status: "active" as const,
            updatedAt: now,
            version: 0,
          }),
          listEntityEdges: async () => ({
            items: [
              {
                brainId,
                confidence: 1,
                createdAt: now,
                documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
                evidence: {},
                extractionMethod: "deterministic" as const,
                from: {
                  id: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
                  kind: "document" as const,
                },
                id: "01ARZ3NDEKTSV4RRFFQ69G5FC3",
                lifecycle: "active" as const,
                organizationId,
                relation: "mentions",
                renditionId: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
                reviewStatus: "approved" as const,
                to: {
                  id: "01ARZ3NDEKTSV4RRFFQ69G5FBZ",
                  kind: "entity" as const,
                },
                updatedAt: now,
                version: 0,
              },
            ],
          }),
        }
      : {}),
  };
  return partial as unknown as BrainRepository;
}

export function runtime(beforeDisclosure?: () => void): BrainQueryRuntime {
  return {
    ask: async () => ({ claims: [], gaps: [], queryAttemptId: "attempt-1", usedCitations: [] }),
    search: async (input) => {
      beforeDisclosure?.();
      if (!(await input.authorizeDisclosure(brainId))) {
        throw new Error("authorization changed before disclosure");
      }
      return {
        queryAttemptId: "attempt-1",
        results: [
          {
            citation: {
              brainId,
              chunkId: "chunk-1",
              coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
              documentId: "document-1",
              documentVersionId: "version-1",
              renditionId: "rendition-1",
              sourceId: "source-1",
            },
            excerpt: "The rollout changed on Tuesday.",
            score: 0.9,
            sensitivity: "internal",
            title: "Rollout notes",
          },
        ],
      };
    },
  };
}

export const definition = {} as ToolAdapterDefinition;
