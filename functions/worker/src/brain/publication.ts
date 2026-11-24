import {
  runtimeArtifactId,
  type RuntimeArtifact,
  type RuntimeBrainEvidenceContextItem,
  type RuntimeCompletedToolCall,
} from "@deployments-ai/agent-runtime";
import type { BrainRepository } from "@deployments-ai/brains";
import { key, type DynamoDatabaseService, workerPersistence } from "@deployments-ai/db";
import { authorizeBrainRead, type BrainToolRequest } from "./authorization.ts";
import { authorizeRuntimeBrainProvenance } from "./active-recall.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "../types.ts";

const BRAIN_PUBLICATION_ARTIFACT_INDEX = 32;
const MAX_PUBLICATION_BRAINS = 20;
const MAX_PUBLICATION_CITATIONS = 100;

type RecordRuntimeArtifact = NonNullable<AgentRunWorkerDependencies["runtime"]["recordArtifact"]>;

function invalid(message: string): never {
  throw new TypeError(message);
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    return invalid(`${label} must be a string array.`);
  }
  const values = value.map((entry) => entry.trim());
  if (new Set(values).size !== values.length) return invalid(`${label} must be unique.`);
  return values;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredText(value: Readonly<Record<string, unknown>>, field: string, label: string) {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : invalid(`${label}.${field} is required.`);
}

function citation(value: unknown) {
  const item = record(value, "Brain citation");
  return {
    brainId: requiredText(item, "brainId", "Brain citation"),
    chunkId: requiredText(item, "chunkId", "Brain citation"),
    documentId: requiredText(item, "documentId", "Brain citation"),
    documentVersionId: requiredText(item, "documentVersionId", "Brain citation"),
    renditionId: requiredText(item, "renditionId", "Brain citation"),
    sourceId: requiredText(item, "sourceId", "Brain citation"),
  };
}

function activeRecallCitation(value: RuntimeBrainEvidenceContextItem) {
  return citation(value);
}

function callProvenance(call: RuntimeCompletedToolCall) {
  const input = record(call.input, "Brain tool input");
  const output = record(call.output, "Brain tool output");
  if (output.kind !== "brain-evidence-provenance") {
    return invalid("Brain tool output provenance is missing.");
  }
  const requestedBrainIds =
    typeof input.brainId === "string" && input.brainId.trim()
      ? [input.brainId.trim()]
      : stringArray(input.brainIds, "Brain tool input brainIds");
  const outputBrainIds = stringArray(output.brainIds, "Brain tool output brainIds");
  if (
    requestedBrainIds.length !== outputBrainIds.length ||
    requestedBrainIds.some((brainId) => !outputBrainIds.includes(brainId))
  ) {
    return invalid("Brain tool output scope does not match its authorized input.");
  }
  if (!Array.isArray(output.citations)) return invalid("Brain tool citations must be an array.");
  return {
    brainIds: requestedBrainIds,
    citations: output.citations.map(citation),
  };
}

async function deploymentForRun(database: DynamoDatabaseService, run: RunRecordValue) {
  if (run.data.agentDeploymentId === undefined) {
    return invalid("Brain publication requires a deployed agent run.");
  }
  const partition = key("ORG", run.data.organizationId, "ENV", run.data.environmentId);
  const [value, release] = await Promise.all([
    workerPersistence.read(
      database,
      "control",
      { pk: partition, sk: key("AGENT-DEPLOYMENT", run.data.agentDeploymentId) },
      true,
    ),
    workerPersistence.read(
      database,
      "control",
      { pk: partition, sk: key("AGENT-RELEASE", run.data.agentReleaseId) },
      true,
    ),
  ]);
  if (
    value?.itemType !== "agent-deployment" ||
    value.data.organizationId !== run.data.organizationId ||
    value.data.projectId !== run.data.projectId ||
    value.data.environmentId !== run.data.environmentId
  ) {
    return invalid("Brain publication deployment is unavailable.");
  }
  if (
    release?.itemType !== "agent-release" ||
    release.data.id !== run.data.agentReleaseId ||
    release.data.agentDefinitionId !== value.data.agentDefinitionId ||
    release.data.status !== "active"
  ) {
    return invalid("Brain publication release is unavailable.");
  }
  return { deployment: value, release };
}

export function createBrainPublicationPreparer(input: {
  readonly database: DynamoDatabaseService;
  readonly recordArtifact: RecordRuntimeArtifact;
  readonly repository: BrainRepository;
}): NonNullable<AgentRunWorkerDependencies["prepareBrainPublication"]> {
  return async ({ body, brainEvidence, brainToolCalls, run, signal }) => {
    const initiator = run.data.initiatingCaller;
    if (initiator?.type !== "service-account") {
      return invalid("Brain private publication requires a service-account run initiator.");
    }
    // Preview runs may read Brains through their source deployment, but no preview or evaluation
    // run publishes Brain-derived answers: such runs fail closed instead of disclosing Brain content.
    if (run.data.agentDeploymentId === undefined) {
      return invalid("Brain publication requires a deployed agent run.");
    }
    const { deployment, release } = await deploymentForRun(input.database, run);
    const provenance = brainToolCalls.map(callProvenance);
    const activeCitations = brainEvidence.map(activeRecallCitation);
    const brainIds = [
      ...new Set([
        ...provenance.flatMap((value) => value.brainIds),
        ...activeCitations.map((value) => value.brainId),
      ]),
    ];
    if (brainIds.length > MAX_PUBLICATION_BRAINS) {
      return invalid(`Brain publication exceeds ${MAX_PUBLICATION_BRAINS} Brains.`);
    }
    const citations = [
      ...new Map(
        [...provenance.flatMap((value) => value.citations), ...activeCitations].map((value) => [
          [
            value.brainId,
            value.documentId,
            value.documentVersionId,
            value.renditionId,
            value.chunkId,
          ].join(":"),
          value,
        ]),
      ).values(),
    ];
    if (citations.length > MAX_PUBLICATION_CITATIONS) {
      return invalid(`Brain publication exceeds ${MAX_PUBLICATION_CITATIONS} citations.`);
    }
    for (const call of brainToolCalls) {
      const scoped = callProvenance(call);
      for (const brainId of scoped.brainIds) {
        const brain = await input.repository.get(run.data.organizationId, brainId);
        if (!brain) return invalid("Brain access changed before private publication.");
        await authorizeBrainRead({
          brain,
          database: input.database,
          repository: input.repository,
          request: {
            agentDefinitionId: deployment.data.agentDefinitionId,
            agentDeploymentId: run.data.agentDeploymentId,
            agentReleaseId: run.data.agentReleaseId,
            decision: { action: "allow", reason: call.policyReason, toolCallId: call.toolCallId },
            effect: "read",
            environmentId: run.data.environmentId,
            idempotencyKey: call.idempotencyKey,
            ...(call.input ? { input: call.input } : {}),
            inputSummary: call.inputSummary,
            organizationId: run.data.organizationId,
            projectId: run.data.projectId,
            requiredScopes: call.requiredScopes,
            runId: run.data.id,
            ...(signal ? { signal } : {}),
            threadId: run.data.threadId,
            toolName: call.toolName,
            ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
          },
        });
      }
    }
    if (activeCitations.length > 0) {
      const request: BrainToolRequest = {
        agentDefinitionId: deployment.data.agentDefinitionId,
        agentDeploymentId: run.data.agentDeploymentId,
        agentReleaseId: run.data.agentReleaseId,
        decision: {
          action: "allow",
          reason: "Revalidate active Brain evidence before private publication.",
          toolCallId: run.data.id,
        },
        effect: "read",
        environmentId: run.data.environmentId,
        idempotencyKey: `${run.data.id}:active-brain-publication`,
        inputSummary: "Revalidate active Brain evidence before private publication.",
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        requiredScopes: ["brains:read"],
        runId: run.data.id,
        ...(signal ? { signal } : {}),
        threadId: run.data.threadId,
        toolName: "agent.brain.search",
        ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
      };
      if (
        !(await authorizeRuntimeBrainProvenance({
          citations: activeCitations,
          database: input.database,
          repository: input.repository,
          request,
        }))
      ) {
        return invalid("Active Brain evidence changed before private publication.");
      }
    }
    const artifactId = runtimeArtifactId(run.data.id, BRAIN_PUBLICATION_ARTIFACT_INDEX);
    const artifact: RuntimeArtifact = {
      content: body,
      contentType: "text/markdown; charset=utf-8",
      fileName: `brain-answer-${artifactId}.md`,
      label: "Private Brain answer",
      metadata: {
        brainIds,
        citations,
        initiatingServiceAccountId: initiator.serviceAccountId,
        kind: "brain-private-publication",
      },
      type: "brain-private-publication",
      visibility: "private",
    };
    await input.recordArtifact(artifact, BRAIN_PUBLICATION_ARTIFACT_INDEX, {
      agentDefinitionId: deployment.data.agentDefinitionId,
      agentDeploymentId: run.data.agentDeploymentId,
      agentManifestHash: release.data.contentHash,
      agentReleaseId: run.data.agentReleaseId,
      captureMode: run.data.captureMode,
      environmentId: run.data.environmentId,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      runId: run.data.id,
      spanId: run.data.spanId,
      threadId: run.data.threadId,
      traceId: run.data.traceId,
      ...(run.data.parentSpanId ? { parentSpanId: run.data.parentSpanId } : {}),
      ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
    });
    return {
      body: [
        "Brain-derived content is available only through the authenticated private artifact API.",
        `Artifact: ${artifactId}`,
        `GET /v1/artifacts/${artifactId}`,
        `POST /v1/artifacts/${artifactId}/access-urls`,
      ].join("\n"),
      messageMetadata: {
        brainIds,
        brainPublicationArtifactId: artifactId,
        kind: "brain-private-publication-link",
      },
    };
  };
}
