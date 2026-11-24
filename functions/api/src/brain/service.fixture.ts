import type {
  Brain,
  BrainGrant,
  BrainRepository,
  BrainSource,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService, PlatformRecord } from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { makeBrainApiService } from "./service.ts";
import type { BrainApiInvocation, BrainApiServiceDependencies } from "./service-contracts.ts";

export const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ownerId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
export const serviceAccountId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
export const credentialId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
export const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
export const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
export const timestamp = "2026-07-30T12:00:00.000Z";
export const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FB5";

export const brain: Brain = {
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Engineering",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "engineering",
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};

export const ownerGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  grantedByPrincipalId: principalId,
  id: grantId,
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

export const source: BrainSource = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};

export const contentHash =
  "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const uploadTicket: BrainUploadTicket = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  expectedByteSize: 3,
  expectedContentHash: contentHash,
  expiresAt: "2026-07-30T12:05:00.000Z",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  mediaType: "text/plain",
  objectKey: `organizations/${organizationId}/brains/${brainId}/uploads/ticket`,
  organizationId,
  sourceId,
  status: "issued",
  updatedAt: timestamp,
  version: 0,
};

export const humanIdentity = {
  authentication: "tenant-jwt",
  organizationIds: [organizationId],
  principalId,
  scopes: ["brains:*"],
} as const satisfies ApiIdentity;

export function record(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
) {
  return { data, itemType, pk: "pk", sk: "sk" } as PlatformRecord;
}

export function database(records: Readonly<Record<string, PlatformRecord>>): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: (_table, key) =>
      Promise.resolve(records[`${key.pk}|${key.sk}`] ? records[`${key.pk}|${key.sk}`]! : undefined),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async () => {},
  };
}

export function liveHumanRecords(
  membershipStatus: "active" | "removed" = "active",
): Readonly<Record<string, PlatformRecord>> {
  return {
    [`ORG#${organizationId}|ORG#${organizationId}`]: record("organization", {
      id: organizationId,
      status: "active",
    }),
    [`PRINCIPAL#${principalId}|PRINCIPAL#${principalId}`]: record("principal", {
      id: principalId,
      kind: "human",
      status: "active",
    }),
    [`ORG#${organizationId}|ORGANIZATION-MEMBER#${principalId}`]: record("organization-member", {
      organizationId,
      principalId,
      role: "owner",
      status: membershipStatus,
    }),
  };
}

export function repository(overrides: Partial<BrainRepository> = {}): BrainRepository {
  return {
    beginErasure: async ({ erasure }) => erasure,
    beginUpload: async ({ next }) => next,
    captureDocumentRevision: async ({ document, version }) => ({ document, version }),
    createSource: async ({ source: value }) => value,
    createWithOwner: async ({ brain: value }) => value,
    completeUpload: async ({ next }) => next,
    findDocumentBySourceIdentity: async () => undefined,
    findEntityByAlias: async () => undefined,
    findActiveGrant: async () => ownerGrant,
    findActiveMount: async () => undefined,
    findSourceRevisionClaim: async () => undefined,
    get: async () => brain,
    getErasure: async () => undefined,
    getDocument: async () => undefined,
    getDocumentRendition: async () => undefined,
    getDocumentVersion: async () => undefined,
    getEntity: async () => undefined,
    getGrant: async () => undefined,
    getMount: async () => undefined,
    getReviewItem: async () => undefined,
    getUploadLease: async () => undefined,
    getUploadTicket: async () => undefined,
    getSource: async () => undefined,
    listByOrganization: async () => ({ items: [brain] }),
    listDocuments: async () => ({ items: [] }),
    listDocumentsBySource: async () => ({ items: [] }),
    listGrants: async () => ({ items: [ownerGrant] }),
    listIndexHealth: async () => ({ items: [] }),
    listEntityEdges: async () => ({ items: [] }),
    listMounts: async () => ({ items: [] }),
    listReviewItems: async () => ({ items: [] }),
    listSources: async () => ({ items: [] }),
    issueUploadTicket: async ({ ticket }) => ticket,
    putGrant: async ({ grant }) => grant,
    putMount: async ({ mount }) => mount,
    revokeGrant: async ({ grant, revokedAt }) => ({
      ...grant,
      revokedAt,
      status: "revoked",
      updatedAt: revokedAt,
      version: grant.version + 1,
    }),
    revokeMount: async ({ mount, revokedAt }) => ({
      ...mount,
      revokedAt,
      status: "revoked",
      updatedAt: revokedAt,
      version: mount.version + 1,
    }),
    resolveReviewItem: async ({ reviewItem }) => reviewItem,
    transferMemberPrivateOwnership: async ({ brain: value }) => value,
    update: async ({ brain: value }) => value,
    ...overrides,
  };
}

export function invocation(overrides: Partial<BrainApiInvocation> = {}): BrainApiInvocation {
  return {
    body: undefined,
    identity: humanIdentity,
    organizationId,
    params: { brainId },
    query: {},
    ...overrides,
  };
}

export function service(
  overrides: Partial<BrainApiServiceDependencies> = {},
  ids = [brainId, grantId, "01ARZ3NDEKTSV4RRFFQ69G5FB4"],
) {
  return makeBrainApiService({
    database: database(liveHumanRecords()),
    generateId: async () => ids.shift()!,
    now: () => timestamp,
    repository: repository(),
    ...overrides,
  });
}
