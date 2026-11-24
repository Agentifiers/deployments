import type {
  CreatePreviewRequest,
  PreviewResponse,
  SubmitAgentRunResponse,
  SubmitPreviewTurnRequest,
} from "@deployments-ai/api-contract/runtime";
import type { PlatformResponse, PlatformSdk } from "./index.ts";
import { type RuntimeMutationOptions, mutation, segment } from "./runtime-sdk-client.ts";

export type CreatePreviewInput = typeof CreatePreviewRequest.Encoded;
export type SubmitPreviewTurnInput = typeof SubmitPreviewTurnRequest.Encoded;

export interface RuntimePreviewsSdk {
  create(
    input: CreatePreviewInput,
    options: RuntimeMutationOptions,
  ): Promise<PlatformResponse<PreviewResponse>>;
  get(previewId: string): Promise<PlatformResponse<PreviewResponse>>;
  delete(previewId: string): Promise<PlatformResponse<PreviewResponse>>;
  submitTurn(
    previewId: string,
    input: SubmitPreviewTurnInput,
    options: RuntimeMutationOptions,
  ): Promise<PlatformResponse<SubmitAgentRunResponse>>;
}

export function createRuntimePreviewsSdk(
  request: <T>(input: Parameters<PlatformSdk["request"]>[0]) => Promise<PlatformResponse<T>>,
): RuntimePreviewsSdk {
  return {
    create: async (body, options) =>
      request({
        method: "POST",
        path: "/v1/previews",
        body,
        ...mutation(options, "Preview creation"),
      }),
    get: (previewId) => request({ method: "GET", path: `/v1/previews/${segment(previewId)}` }),
    delete: (previewId) =>
      request({ method: "DELETE", path: `/v1/previews/${segment(previewId)}` }),
    submitTurn: async (previewId, body, options) =>
      request({
        method: "POST",
        path: `/v1/previews/${segment(previewId)}/turns`,
        body,
        ...mutation(options, "Preview turn submission"),
      }),
  };
}
