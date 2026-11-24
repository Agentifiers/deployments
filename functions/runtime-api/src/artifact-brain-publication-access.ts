import { authorizeBrainAccess, type Brain } from "@deployments-ai/brains";
import {
  artifactOwnerOf,
  key,
  makeBrainDynamoRepository,
  sameArtifactOwner,
} from "@deployments-ai/db";
import type { Artifact } from "./artifact-storage.ts";
import { runInitiatingCaller } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  getRecord,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value.map((item) => item.trim())
    : undefined;
}

function scopeAllows(scopes: readonly string[], required: string) {
  return (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes("brains:*") ||
    scopes.includes(required)
  );
}

async function brainOwnerActive(
  dependencies: RuntimeApiDependencies,
  brain: Brain,
): Promise<boolean> {
  if (brain.kind === "company") return true;
  if (!brain.ownerPrincipalId) return false;
  const [owner, membership] = await Promise.all([
    getRecord(dependencies.database, "control", {
      pk: key("PRINCIPAL", brain.ownerPrincipalId),
      sk: key("PRINCIPAL", brain.ownerPrincipalId),
    }),
    getRecord(dependencies.database, "control", {
      pk: key("ORG", brain.organizationId),
      sk: key("ORGANIZATION-MEMBER", brain.ownerPrincipalId),
    }),
  ]);
  return (
    owner?.itemType === "principal" &&
    owner.data.kind === "human" &&
    owner.data.status === "active" &&
    membership?.itemType === "organization-member" &&
    membership.data.status === "active"
  );
}

export async function authorizeBrainPublicationArtifact(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  record: Artifact,
) {
  const source = object(record.data.metadata?.source);
  // Brain publications are private to the service account whose run published them.
  if (principal.kind === "human") {
    throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
  }
  const brainIds = strings(source?.brainIds);
  const citations = source?.citations;
  if (
    source?.kind !== "brain-private-publication" ||
    source.initiatingServiceAccountId !== principal.serviceAccount.data.id ||
    !sameArtifactOwner(record.data.owner, artifactOwnerOf(runInitiatingCaller(principal))) ||
    !brainIds ||
    brainIds.length < 1 ||
    brainIds.length > 20 ||
    new Set(brainIds).size !== brainIds.length ||
    !Array.isArray(citations) ||
    citations.length > 100
  ) {
    throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
  }
  const repository = makeBrainDynamoRepository(dependencies.database);
  const organization = await getRecord(dependencies.database, "control", {
    pk: key("ORG", principal.scope.organizationId),
    sk: key("ORG", principal.scope.organizationId),
  });
  const effectiveScopes =
    scopeAllows(principal.credential.data.scopes, "brains:read") &&
    scopeAllows(principal.serviceAccount.data.scopes, "brains:read")
      ? ["brains:read"]
      : [];
  for (const brainId of brainIds) {
    const [brain, callerGrant] = await Promise.all([
      repository.get(principal.scope.organizationId, brainId),
      repository.findActiveGrant(principal.scope.organizationId, brainId, {
        environmentId: principal.scope.environmentId,
        projectId: principal.scope.projectId,
        serviceAccountId: principal.serviceAccount.data.id,
        type: "service-account",
      }),
    ]);
    if (!brain) throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
    const decision = authorizeBrainAccess({
      brain,
      caller: {
        credentialActive:
          principal.credential.data.status === "active" &&
          principal.credential.data.revokedAt === undefined &&
          (!principal.credential.data.expiresAt ||
            principal.credential.data.expiresAt >
              (dependencies.now?.() ?? new Date()).toISOString()),
        environmentId: principal.scope.environmentId,
        kind: "service",
        organizationId: principal.scope.organizationId,
        projectId: principal.scope.projectId,
        scopes: effectiveScopes,
        serviceAccountActive: principal.serviceAccount.data.status === "active",
        serviceAccountId: principal.serviceAccount.data.id,
      },
      ...(callerGrant ? { callerGrant } : {}),
      operation: "read",
      organizationActive:
        organization?.itemType === "organization" && organization.data.status === "active",
      ownerActive: await brainOwnerActive(dependencies, brain),
    });
    if (!decision.allowed) {
      throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
    }
  }
  for (const value of citations) {
    const citation = object(value);
    if (!citation) throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
    const brainId = typeof citation.brainId === "string" ? citation.brainId : undefined;
    const sourceId = typeof citation.sourceId === "string" ? citation.sourceId : undefined;
    const documentId = typeof citation.documentId === "string" ? citation.documentId : undefined;
    const versionId =
      typeof citation.documentVersionId === "string" ? citation.documentVersionId : undefined;
    const renditionId = typeof citation.renditionId === "string" ? citation.renditionId : undefined;
    if (
      !brainId ||
      !sourceId ||
      !documentId ||
      !versionId ||
      !renditionId ||
      !brainIds.includes(brainId)
    ) {
      throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
    }
    const [brainSource, document, version, rendition] = await Promise.all([
      repository.getSource(principal.scope.organizationId, brainId, sourceId),
      repository.getDocument(principal.scope.organizationId, brainId, documentId),
      repository.getDocumentVersion(principal.scope.organizationId, documentId, versionId),
      repository.getDocumentRendition(principal.scope.organizationId, versionId, renditionId),
    ]);
    if (
      brainSource?.status !== "active" ||
      document?.lifecycle !== "active" ||
      document.reviewStatus === "rejected" ||
      document.sourceId !== sourceId ||
      document.currentContentVersionId !== versionId ||
      version?.brainId !== brainId ||
      version.sourceId !== sourceId ||
      rendition?.brainId !== brainId ||
      rendition.documentId !== documentId ||
      rendition.contentHash !== version.contentHash
    ) {
      throw new RuntimeApiError(404, "not_found", "Artifact was not found.");
    }
  }
}
