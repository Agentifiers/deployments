import { createAgentEmailSdk } from "./agent-email.ts";
import { createEmailSdk } from "./email.ts";
import { createEvaluationsSdk } from "./evaluations.ts";
import { createEvaluationMockState } from "./evaluation-mock-state.ts";
import {
  validateRequestPath,
  type PlatformRequest,
  type PlatformResponse,
  type PlatformSdk,
} from "./index.ts";
import { createMemorySdk } from "./memory.ts";
import { createObservabilitySdk } from "./observability.ts";
import { createRuntimeSdk } from "./runtime.ts";
import { createTenancyMockState } from "./tenancy-mock.ts";

import { mockData } from "./mock-responses.ts";
import type { CreateMockPlatformSdkOptions } from "./mock-state.ts";
export function createMockPlatformSdk(options: CreateMockPlatformSdkOptions = {}): PlatformSdk {
  const now = options.now ?? (() => new Date());
  const tenancyState = createTenancyMockState();
  const evaluationState = createEvaluationMockState();
  let operationTail: Promise<void> = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = operationTail;
    let release!: () => void;
    operationTail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const sdk: PlatformSdk = {
    async request<T>(request: PlatformRequest): Promise<PlatformResponse<T>> {
      validateRequestPath(request.path);
      const timestamp = now().toISOString();
      return {
        data: (await serialize(() =>
          mockData(request, timestamp, tenancyState, evaluationState),
        )) as T,
        requestId: `req_mock_${timestamp.replaceAll(/\D/gu, "").slice(0, 17)}`,
        mocked: true,
      };
    },
    async *stream<T>(request: PlatformRequest): AsyncIterable<T> {
      validateRequestPath(request.path);
      const timestamp = now().toISOString();
      const data = await serialize(() =>
        mockData(request, timestamp, tenancyState, evaluationState),
      );
      if (
        typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { items?: unknown }).items)
      ) {
        for (const item of (data as { items: unknown[] }).items) yield item as T;
        return;
      }
      yield data as T;
    },
    async streamPage<T>(request: PlatformRequest) {
      const items: T[] = [];
      for await (const item of sdk.stream<T>(request)) items.push(item);
      return {
        closed: true,
        items,
        requestId: `req_mock_${now().toISOString().replaceAll(/\D/gu, "").slice(0, 17)}`,
      };
    },
    async *streamBatches<T>(request: PlatformRequest) {
      yield await sdk.streamPage<T>(request);
    },
    async uploadPresigned() {},
    agentEmail: (context) => createAgentEmailSdk(sdk, context),
    email: (context) => createEmailSdk(sdk, context),
    evaluations: (context) => createEvaluationsSdk(sdk, context),
    memory: (context) => createMemorySdk(sdk, context),
    observability: (context) => createObservabilitySdk(sdk, context),
    runtime: (context) => createRuntimeSdk(sdk, context),
  };
  return sdk;
}

export { createAgentEmailSdk } from "./agent-email.ts";
export type {
  AgentEmailAccessUrl,
  AgentEmailContext,
  AgentEmailDraftListOptions,
  AgentEmailInboxListOptions,
  AgentEmailListOptions,
  AgentEmailMessageListOptions,
  AgentEmailMutationOptions,
  AgentEmailSdk,
  AgentEmailThreadDetail,
  AgentEmailUsageExport,
  AgentEmailUsageOptions,
  AgentEmailUsageSummary,
} from "./agent-email.ts";
