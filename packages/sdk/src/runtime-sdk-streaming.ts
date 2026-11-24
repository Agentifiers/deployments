import type { PlatformSdk } from "./index.ts";
import { uploadArtifactBytes } from "./runtime-sdk-artifact-upload.ts";
import { createEndUserErasures, createThreadErasures } from "./runtime-sdk-erasures.ts";
import { createRuntimePreviewsSdk } from "./runtime-sdk-previews.ts";
import { createThreadStreamReads } from "./runtime-sdk-thread-stream.ts";
import {
  createRuntimeWebhookDeliveriesSdk,
  createRuntimeWebhooksSdk,
} from "./runtime-sdk-webhooks.ts";

import {
  type RuntimeContext,
  type RuntimeSdk,
  fireMutation,
  mutation,
  segment,
} from "./runtime-sdk-client.ts";
export function createRuntimeSdk(sdk: PlatformSdk, context: RuntimeContext): RuntimeSdk {
  const request = <T>(input: Parameters<PlatformSdk["request"]>[0]) =>
    sdk.request<T>({ ...input, context });

  const runtime: RuntimeSdk = {
    previews: createRuntimePreviewsSdk(request),
    workflowExecutions: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/workflow-executions",
          query: { cursor: options.cursor, limit: options.limit, status: options.status },
        }),
      start: (workflowReleaseId, body, options) =>
        request({
          method: "POST",
          path: `/v1/workflow-releases/${segment(workflowReleaseId)}/executions`,
          body,
          ...mutation(options, "Workflow execution start"),
        }),
      get: (workflowExecutionId) =>
        request({
          method: "GET",
          path: `/v1/workflow-executions/${segment(workflowExecutionId)}`,
        }),
      cancel: (workflowExecutionId, body) =>
        request({
          method: "POST",
          path: `/v1/workflow-executions/${segment(workflowExecutionId)}/cancel`,
          body,
        }),
      listSteps: (workflowExecutionId, options = {}) =>
        request({
          method: "GET",
          path: `/v1/workflow-executions/${segment(workflowExecutionId)}/steps`,
          query: { cursor: options.cursor, limit: options.limit },
        }),
    },
    workflowApprovals: {
      get: (workflowExecutionId, workflowApprovalId) =>
        request({
          method: "GET",
          path: `/v1/workflow-executions/${segment(workflowExecutionId)}/approvals/${segment(workflowApprovalId)}`,
        }),
      resolve: (workflowExecutionId, workflowApprovalId, body) =>
        request({
          method: "POST",
          path: `/v1/workflow-executions/${segment(workflowExecutionId)}/approvals/${segment(workflowApprovalId)}/resolve`,
          body,
        }),
    },
    runs: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/runs",
          query: {
            agentDeploymentId: options.agentDeploymentId,
            agentReleaseId: options.agentReleaseId,
            createdAfter: options.createdAfter,
            createdBefore: options.createdBefore,
            cursor: options.cursor,
            executionBindingId: options.executionBindingId,
            executionPurpose: options.executionPurpose,
            limit: options.limit,
            status: options.status,
            threadId: options.threadId,
          },
        }),
      search: (body) =>
        request({
          method: "POST",
          path: "/v1/runs/search",
          body,
        }),
      submit: async (agentDeploymentId, body, options) =>
        request({
          method: "POST",
          path: `/v1/agent-deployments/${segment(agentDeploymentId)}/runs`,
          body,
          ...mutation(options, "Agent run submission"),
        }),
      get: (threadId, runId) =>
        request({
          method: "GET",
          path: `/v1/threads/${segment(threadId)}/runs/${segment(runId)}`,
        }),
      getById: (runId) => request({ method: "GET", path: `/v1/runs/${segment(runId)}` }),
      getMessage: (threadId, runId) =>
        request({
          method: "GET",
          path: `/v1/threads/${segment(threadId)}/runs/${segment(runId)}/message`,
        }),
      reserveMessagePublication: (threadId, runId, body, options) =>
        request({
          method: "POST",
          path: `/v1/threads/${segment(threadId)}/runs/${segment(runId)}/message/publication-reservations`,
          body,
          ...mutation(options, "Run message publication reservation"),
        }),
      publishMessage: (threadId, runId, body, options) =>
        request({
          method: "POST",
          path: `/v1/threads/${segment(threadId)}/runs/${segment(runId)}/message/publications`,
          body,
          ...mutation(options, "Run message publication"),
        }),
      releaseMessagePublication: (threadId, runId, body, options) =>
        request({
          method: "POST",
          path: `/v1/threads/${segment(threadId)}/runs/${segment(runId)}/message/publication-releases`,
          body,
          ...mutation(options, "Run message publication release"),
        }),
      cancel: (runId) =>
        request({
          method: "POST",
          path: `/v1/runs/${segment(runId)}/cancel`,
        }),
      retry: (runId) =>
        request({
          method: "POST",
          path: `/v1/runs/${segment(runId)}/retry`,
        }),
      replay: async (runId, options) =>
        request({
          method: "POST",
          path: `/v1/runs/${segment(runId)}/replay`,
          ...mutation(options, "Agent run replay"),
        }),
    },
    threads: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/threads",
          query: {
            cursor: options.cursor,
            executionBindingId: options.executionBindingId,
            limit: options.limit,
          },
        }),
      create: (body) =>
        request({
          method: "POST",
          path: "/v1/threads",
          body,
        }),
      get: (threadId) => request({ method: "GET", path: `/v1/threads/${segment(threadId)}` }),
      archive: (threadId) =>
        request({
          method: "POST",
          path: `/v1/threads/${segment(threadId)}/archive`,
        }),
      ...createThreadErasures(request),
      listMessages: (threadId, options = {}) =>
        request({
          method: "GET",
          path: `/v1/threads/${segment(threadId)}/messages`,
          query: { cursor: options.cursor, limit: options.limit },
        }),
      createStreamSession: (threadId) =>
        request({
          method: "POST",
          path: `/v1/threads/${segment(threadId)}/stream-sessions`,
        }),
      ...createThreadStreamReads(sdk),
    },
    endUsers: createEndUserErasures(request),
    approvals: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/approvals",
          query: { cursor: options.cursor, limit: options.limit, status: options.status },
        }),
      get: (runId, approvalId) =>
        request({
          method: "GET",
          path: `/v1/runs/${segment(runId)}/approvals/${segment(approvalId)}`,
        }),
      resolve: (runId, approvalId, body) =>
        request({
          method: "POST",
          path: `/v1/runs/${segment(runId)}/approvals/${segment(approvalId)}/resolve`,
          body,
        }),
    },
    toolCalls: {
      list: (runId, options = {}) =>
        request({
          method: "GET",
          path: `/v1/runs/${segment(runId)}/tool-calls`,
          query: { cursor: options.cursor, limit: options.limit },
        }),
      resolve: (runId, toolCallId, body) =>
        request({
          method: "POST",
          path: `/v1/runs/${segment(runId)}/tool-calls/${segment(toolCallId)}/results`,
          body,
        }),
    },
    webhooks: createRuntimeWebhooksSdk(request),
    webhookDeliveries: createRuntimeWebhookDeliveriesSdk(request),
    artifacts: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/artifacts",
          query: {
            contentType: options.contentType,
            createdAfter: options.createdAfter,
            createdBefore: options.createdBefore,
            cursor: options.cursor,
            limit: options.limit,
            runId: options.runId,
            threadId: options.threadId,
            type: options.type,
          },
        }),
      createUpload: (body) =>
        request({
          method: "POST",
          path: "/v1/artifacts",
          body,
        }),
      get: (artifactId) => request({ method: "GET", path: `/v1/artifacts/${segment(artifactId)}` }),
      completeUpload: (artifactId) =>
        request({
          method: "POST",
          path: `/v1/artifacts/${segment(artifactId)}/complete`,
        }),
      uploadBytes: (input) => uploadArtifactBytes(sdk, runtime.artifacts, input),
      updateRetention: (artifactId, body) =>
        request({
          method: "PATCH",
          path: `/v1/artifacts/${segment(artifactId)}/retention`,
          body,
        }),
      createAccessUrl: (artifactId, body = {}) =>
        request({
          method: "POST",
          path: `/v1/artifacts/${segment(artifactId)}/access-urls`,
          body,
        }),
      delete: (artifactId) =>
        request({ method: "DELETE", path: `/v1/artifacts/${segment(artifactId)}` }),
    },
    channelBindings: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/channel-bindings",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      create: async (body, options) =>
        request({
          method: "POST",
          path: "/v1/channel-bindings",
          body,
          ...mutation(options, "Channel binding creation"),
        }),
      get: (bindingId) =>
        request({
          method: "GET",
          path: `/v1/channel-bindings/${segment(bindingId)}`,
        }),
      update: (bindingId, body) =>
        request({
          method: "PATCH",
          path: `/v1/channel-bindings/${segment(bindingId)}`,
          body,
        }),
      archive: (bindingId) =>
        request({
          method: "DELETE",
          path: `/v1/channel-bindings/${segment(bindingId)}`,
        }),
      verify: (bindingId) =>
        request({
          method: "POST",
          path: `/v1/channel-bindings/${segment(bindingId)}/verify`,
        }),
      composeDelivery: async (bindingId, body, options) =>
        request({
          method: "POST",
          path: `/v1/channel-bindings/${segment(bindingId)}/deliveries`,
          body,
          ...mutation(options, "Channel delivery composition"),
        }),
    },
    channelDeliveries: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/channel-deliveries",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      get: (runId, deliveryId) =>
        request({
          method: "GET",
          path: `/v1/runs/${segment(runId)}/channel-deliveries/${segment(deliveryId)}`,
        }),
    },
    schedules: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/schedules",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      create: async (body, options) =>
        request({
          method: "POST",
          path: "/v1/schedules",
          body,
          ...mutation(options, "Schedule creation"),
        }),
      get: (scheduleId) => request({ method: "GET", path: `/v1/schedules/${segment(scheduleId)}` }),
      update: (scheduleId, body) =>
        request({
          method: "PATCH",
          path: `/v1/schedules/${segment(scheduleId)}`,
          body,
        }),
      pause: (scheduleId) =>
        request({
          method: "POST",
          path: `/v1/schedules/${segment(scheduleId)}/pause`,
        }),
      resume: (scheduleId) =>
        request({
          method: "POST",
          path: `/v1/schedules/${segment(scheduleId)}/resume`,
        }),
      archive: (scheduleId) =>
        request({
          method: "DELETE",
          path: `/v1/schedules/${segment(scheduleId)}`,
        }),
      listFires: (scheduleId, options = {}) =>
        request({
          method: "GET",
          path: `/v1/schedules/${segment(scheduleId)}/fires`,
          query: { cursor: options.cursor, limit: options.limit },
        }),
      fire: async (scheduleId, ...args) => {
        const [body = {}, options] = args;
        return request({
          method: "POST",
          path: `/v1/schedules/${segment(scheduleId)}/fire`,
          body,
          ...fireMutation(body, options, "Schedule fire"),
        });
      },
    },
    heartbeats: {
      list: (options = {}) =>
        request({
          method: "GET",
          path: "/v1/heartbeats",
          query: { cursor: options.cursor, limit: options.limit },
        }),
      create: async (body, options) =>
        request({
          method: "POST",
          path: "/v1/heartbeats",
          body,
          ...mutation(options, "Heartbeat creation"),
        }),
      get: (heartbeatId) =>
        request({ method: "GET", path: `/v1/heartbeats/${segment(heartbeatId)}` }),
      update: (heartbeatId, body) =>
        request({
          method: "PATCH",
          path: `/v1/heartbeats/${segment(heartbeatId)}`,
          body,
        }),
      pause: (heartbeatId) =>
        request({
          method: "POST",
          path: `/v1/heartbeats/${segment(heartbeatId)}/pause`,
        }),
      resume: (heartbeatId) =>
        request({
          method: "POST",
          path: `/v1/heartbeats/${segment(heartbeatId)}/resume`,
        }),
      archive: (heartbeatId) =>
        request({
          method: "DELETE",
          path: `/v1/heartbeats/${segment(heartbeatId)}`,
        }),
      listFires: (heartbeatId, options = {}) =>
        request({
          method: "GET",
          path: `/v1/heartbeats/${segment(heartbeatId)}/fires`,
          query: { cursor: options.cursor, limit: options.limit },
        }),
      fire: async (heartbeatId, ...args) => {
        const [body, options] = args;
        return request({
          method: "POST",
          path: `/v1/heartbeats/${segment(heartbeatId)}/fire`,
          body,
          ...fireMutation(body, options, "Heartbeat fire"),
        });
      },
    },
  };
  return runtime;
}
