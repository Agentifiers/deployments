import { AgentResponseFormat } from "@deployments-ai/agent-manifest";
import { AgentDeploymentConfigV1 } from "@deployments-ai/agent-manifest/schema";
import { ValidatedAgentManifestV1 } from "@deployments-ai/agent-manifest/semantics";
import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";
import {
  AgentRunContent,
  RuntimeActor,
  RuntimeMutableFields,
  RuntimeTenantFields,
} from "./runtime-request-contracts.ts";

export const PREVIEW_MIN_TTL_SECONDS = 60;
export const PREVIEW_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const PreviewTtlSeconds = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "ttlSeconds must be an integer." }),
    Schema.isBetween(
      { maximum: PREVIEW_MAX_TTL_SECONDS, minimum: PREVIEW_MIN_TTL_SECONDS },
      {
        message: `ttlSeconds must be between ${PREVIEW_MIN_TTL_SECONDS} and ${PREVIEW_MAX_TTL_SECONDS}.`,
      },
    ),
  ),
);

/**
 * Creates a preview of an unpublished manifest. Runtime configuration comes from `runtimeConfig`,
 * a snapshot of `fromAgentDeploymentId`, or the default configuration; the two are exclusive.
 */
export const CreatePreviewRequest = Schema.Struct({
  fromAgentDeploymentId: Schema.optional(PublicId),
  manifest: ValidatedAgentManifestV1,
  runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
  ttlSeconds: Schema.optional(PreviewTtlSeconds),
});

export const PreviewResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  agentName: Schema.String,
  contentHash: Schema.String,
  createdBy: RuntimeActor,
  expiredAt: Schema.optional(Timestamp),
  expiresAt: Timestamp,
  id: PublicId,
  object: Schema.Literal("preview"),
  runtimeConfigFromAgentDeploymentId: Schema.optional(PublicId),
  status: Schema.Literals(["active", "expired"]),
});

export const SubmitPreviewTurnRequest = Schema.Struct({
  content: AgentRunContent,
  responseFormat: Schema.optional(AgentResponseFormat),
  threadId: Schema.optional(PublicId),
});

export type CreatePreviewRequest = typeof CreatePreviewRequest.Type;
export type PreviewResponse = typeof PreviewResponse.Type;
export type SubmitPreviewTurnRequest = typeof SubmitPreviewTurnRequest.Type;
