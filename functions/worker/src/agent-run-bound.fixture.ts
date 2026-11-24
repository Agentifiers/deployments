import { agentManifestContentHash, type AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  ExecutionBindingRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id } from "./agent-run.fixture.ts";

export const bindingId = id(40);

/** A queued run pinned to an active preview or evaluation execution binding (no deployment). */
export function boundFixture(options: {
  readonly manifest?: AgentManifestV1;
  readonly purpose: "evaluation" | "preview";
  readonly source: "manifest" | "release";
  readonly toolPolicy: "evaluation" | "interactive";
}) {
  const base = fixtures();
  const manifest = options.manifest ?? base.release.data.manifest;
  const createdAt = "2026-07-21T00:00:00.000Z";
  const expiresAt = "2026-07-23T00:00:00.000Z";
  const binding = Schema.decodeUnknownSync(ExecutionBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        contentHash: agentManifestContentHash(manifest),
        createdAt,
        createdBy: { id: id(41), type: "principal" as const },
        environmentId: base.run.data.environmentId,
        expiresAt,
        id: bindingId,
        idempotencyKey: "binding-1",
        manifest,
        organizationId: base.run.data.organizationId,
        projectId: base.run.data.projectId,
        purpose: options.purpose,
        source:
          options.source === "release"
            ? {
                agentDefinitionId: base.release.data.agentDefinitionId,
                agentReleaseId: base.release.data.id,
                type: "release" as const,
              }
            : { type: "manifest" as const },
        status: "active" as const,
        toolPolicy: options.toolPolicy,
        updatedAt: createdAt,
        version: 0,
      },
      itemType: "execution-binding" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
  const pins = { executionBindingId: bindingId, executionPurpose: options.purpose };
  const { agentDeploymentId: _threadDeployment, ...threadData } = base.thread.data;
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: { ...threadData, ...pins, channel: options.purpose },
      itemType: "thread" as const,
    }),
  );
  const { agentDeploymentId: _messageDeployment, ...messageData } = base.userMessage.data;
  const userMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({ data: messageData, itemType: "message" as const }),
  );
  const {
    agentDeploymentId: _runDeployment,
    agentReleaseId: _runRelease,
    ...runData
  } = base.run.data;
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...runData,
        ...pins,
        ...(options.source === "release" ? { agentReleaseId: base.release.data.id } : {}),
        trigger: options.purpose,
      },
      itemType: "run" as const,
    }),
  );
  return { binding, queue: base.queue, release: base.release, run, thread, userMessage };
}
