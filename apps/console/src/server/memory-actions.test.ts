import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { createGrant, createPolicy, updatePolicy, type CallRoute } from "./memory-actions.ts";
import { PlatformRequestError } from "./platform-api.ts";

const SCOPE = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600H",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

const POLICY_RECORD = {
  data: {
    ...SCOPE,
    activeRecallEnabled: false,
    activeRecallRolloutPercent: 100,
    createdAt: "2026-10-09T05:00:00.000Z",
    id: "01ARZ3NDEKTSV4RRFFQ69G600M",
    processingConfig: { memoryRetrieval: { strategy: "dense-v1" } },
    retentionDays: 30,
    scope: "environment",
    sensitivityMode: "standard",
    updatedAt: "2026-10-09T05:00:00.000Z",
    version: 1,
  },
  itemType: "memory-policy",
  pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G600C#ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  sk: "MEMORY-POLICY#01ARZ3NDEKTSV4RRFFQ69G600M",
};

function fakeApi(response: unknown) {
  const sent: { readonly name: string; readonly input: unknown }[] = [];
  const callRoute = (async (name: string, input: unknown) => {
    sent.push({ input, name });
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as CallRoute;
  return { callRoute, sent };
}

const mutation = { accessToken: "token", idempotencyKey: "key-1", scope: SCOPE };
const body = {
  activeRecallEnabled: false,
  activeRecallRolloutPercent: 100,
  processingConfig: { memoryRetrieval: { strategy: "dense-v1" } },
  retentionDays: 30,
  sensitivityMode: "standard",
};

describe("memory policy writes", () => {
  test("a create POSTs the full body with every tenant header and returns the decoded policy", async () => {
    const api = fakeApi(POLICY_RECORD);
    const created = await createPolicy(
      { ...mutation, body: { ...body, scope: "environment" } },
      api.callRoute,
    );
    expect(api.sent).toEqual([
      {
        input: { body: { ...body, scope: "environment" }, idempotencyKey: "key-1", scope: SCOPE },
        name: "createMemoryPolicy",
      },
    ]);
    expect(created).toMatchObject({
      id: "01ARZ3NDEKTSV4RRFFQ69G600M",
      retrieval: "dense-v1",
      version: 1,
    });
  });

  test("an edit PUTs to the named policy whatever id the body carried", async () => {
    const api = fakeApi(POLICY_RECORD);
    await updatePolicy(
      {
        ...mutation,
        body: { ...body, id: "01ARZ3NDEKTSV4RRFFQ69G600N" },
        policyId: "01ARZ3NDEKTSV4RRFFQ69G600M",
      },
      api.callRoute,
    );
    expect(api.sent).toEqual([
      {
        input: {
          body: { ...body, id: "01ARZ3NDEKTSV4RRFFQ69G600M" },
          idempotencyKey: "key-1",
          scope: SCOPE,
        },
        name: "upsertMemoryPolicy",
      },
    ]);
  });

  test("passes the placement failure through as the platform's problem", async () => {
    const notEnabled = new PlatformApiError("createMemoryPolicy", {
      code: "memory_internal_error",
      status: 500,
      title: "Memory request failed",
    });
    const api = fakeApi(notEnabled);
    const failure = await createPolicy({ ...mutation, body }, api.callRoute).catch(
      (error: unknown) => error,
    );
    expect(failure).toBe(notEnabled);
  });

  test("refuses a body outside the contract before calling the platform", async () => {
    const api = fakeApi(POLICY_RECORD);
    const refused = await createPolicy(
      { ...mutation, body: { ...body, activeRecallRolloutPercent: 101 } },
      api.callRoute,
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: { status: 400, title: "Invalid request" } });
    expect(api.sent).toEqual([]);
  });

  test("a response that is not a policy record fails instead of rendering", async () => {
    const api = fakeApi({ ...POLICY_RECORD, itemType: "memory-space" });
    const failure = await createPolicy({ ...mutation, body }, api.callRoute).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatformRequestError);
    expect(failure).toMatchObject({
      message:
        "The platform returned a createMemoryPolicy response outside the console's Memory view.",
    });
  });
});

describe("createGrant", () => {
  test("returns the grant the platform stored", async () => {
    const api = fakeApi({
      data: {
        ...SCOPE,
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G600F",
        createdAt: "2026-10-09T06:00:00.000Z",
        id: "01ARZ3NDEKTSV4RRFFQ69G600J",
        memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600K",
        permission: "read",
        updatedAt: "2026-10-09T06:00:00.000Z",
        version: 0,
      },
      itemType: "memory-space-grant",
    });
    const grantBody = {
      agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G600F",
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600K",
      permission: "read",
    };
    expect(await createGrant({ ...mutation, body: grantBody }, api.callRoute)).toMatchObject({
      id: "01ARZ3NDEKTSV4RRFFQ69G600J",
      permission: "read",
      status: "active",
    });
    expect(api.sent).toEqual([
      {
        input: { body: grantBody, idempotencyKey: "key-1", scope: SCOPE },
        name: "createMemorySpaceGrant",
      },
    ]);
  });
});
