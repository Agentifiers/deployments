import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryApi, type MemoryApiEvent } from "./api.ts";

const request: MemoryApiEvent = {
  rawPath: "/v1/memory-space-grants",
  requestContext: {
    authorizer: {
      jwt: {
        claims: {
          environment_id: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
          organization_id: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
          project_id: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
          scope: "memory:admin",
        },
      },
    },
    http: { method: "GET", path: "/v1/memory-space-grants" },
    requestId: "request-grants",
  },
};

describe("memory grant API", () => {
  it("lists grants with filters and pagination", async () => {
    let received: unknown;
    const platform = {
      listMemorySpaceGrantsPage: async (
        _scope: Parameters<MemoryPlatform["listMemorySpaceGrantsPage"]>[0],
        input: Parameters<MemoryPlatform["listMemorySpaceGrantsPage"]>[1],
      ) => {
        received = input;
        return { items: [], nextCursor: "next" };
      },
    } as unknown as MemoryPlatform;
    const result = await handleMemoryApi(
      {
        ...request,
        queryStringParameters: {
          agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
          cursor: "cursor_1",
          limit: "25",
          memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
          status: "revoked",
        },
      },
      { platform },
    );

    expect(result.statusCode).toBe(200);
    expect(received).toEqual({
      agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      cursor: "cursor_1",
      limit: 25,
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      status: "revoked",
    });
  });
});
