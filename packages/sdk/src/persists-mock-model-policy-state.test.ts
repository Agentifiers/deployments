import { describe, expect, it } from "bun:test";
import { MOCK_TENANCY_CONTEXT, PlatformApiError, type PlatformRequest } from "./index.ts";
import { createMockPlatformSdk } from "./mock.ts";

type ModelList = {
  readonly items: readonly { readonly allowed: boolean; readonly modelId: string }[];
  readonly nextCursor: string | null;
  readonly policy: { readonly modelPolicyId?: string; readonly source: string };
};
type Policy = { readonly id: string; readonly status: string; readonly version: number };

const context = MOCK_TENANCY_CONTEXT;
const nonCuratedModel = "openrouter/mistralai/mistral-small-3.2-24b-instruct";

async function problem(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PlatformApiError);
  return (error as PlatformApiError).problem;
}

describe("mock model policy state", () => {
  it("gates catalog admission on the single active environment policy", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-09-29T00:00:00.000Z") });
    const list = async (query: PlatformRequest["query"] = {}) =>
      (await sdk.request<ModelList>({ context, method: "GET", path: "/v1/models", query })).data;
    const allowed = async (modelId: string) =>
      (await list({ search: modelId })).items.find((item) => item.modelId === modelId)?.allowed;

    expect((await list()).policy).toEqual({ source: "curated_defaults" });
    expect(await allowed(nonCuratedModel)).toBe(false);
    expect(await allowed("openrouter/qwen/qwen3.7-plus")).toBe(true);

    expect(
      await problem(
        sdk.request({
          body: { includeCuratedModels: true, models: ["openrouter/unknown/model"], name: "Bad" },
          context,
          idempotencyKey: "invalid-policy",
          method: "POST",
          path: "/v1/model-policies",
        }),
      ),
    ).toMatchObject({ code: "invalid_model_policy", status: 422 });

    const created = (
      await sdk.request<Policy>({
        body: { includeCuratedModels: false, models: [nonCuratedModel], name: "Narrow" },
        context,
        idempotencyKey: "create-policy",
        method: "POST",
        path: "/v1/model-policies",
      })
    ).data;
    expect(created).toMatchObject({ status: "active", version: 1 });
    expect((await list()).policy).toEqual({ modelPolicyId: created.id, source: "model_policy" });
    expect(await allowed(nonCuratedModel)).toBe(true);
    expect(await allowed("openrouter/qwen/qwen3.7-plus")).toBe(false);

    expect(
      await problem(
        sdk.request({
          body: { includeCuratedModels: true, models: [], name: "Second" },
          context,
          idempotencyKey: "second-policy",
          method: "POST",
          path: "/v1/model-policies",
        }),
      ),
    ).toMatchObject({ code: "model_policy_exists", status: 409 });

    const policyPath = `/v1/model-policies/${created.id}`;
    expect(
      await problem(
        sdk.request({
          body: { expectedVersion: 0, includeCuratedModels: true },
          context,
          idempotencyKey: "stale-update",
          method: "PATCH",
          path: policyPath,
        }),
      ),
    ).toMatchObject({ code: "version_conflict", status: 409 });
    const updated = (
      await sdk.request<Policy>({
        body: { expectedVersion: 1, includeCuratedModels: true },
        context,
        idempotencyKey: "update-policy",
        method: "PATCH",
        path: policyPath,
      })
    ).data;
    expect(updated).toMatchObject({ includeCuratedModels: true, version: 2 });
    expect(await allowed("openrouter/qwen/qwen3.7-plus")).toBe(true);

    const archived = (
      await sdk.request<Policy>({
        body: { expectedVersion: 2 },
        context,
        idempotencyKey: "archive-policy",
        method: "DELETE",
        path: policyPath,
      })
    ).data;
    expect(archived).toMatchObject({ status: "archived", version: 3 });
    expect((await list()).policy).toEqual({ source: "curated_defaults" });
    expect(await allowed(nonCuratedModel)).toBe(false);
  });

  it("filters and pages the catalog by model id", async () => {
    const sdk = createMockPlatformSdk();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const { data } = await sdk.request<ModelList>({
        context,
        method: "GET",
        path: "/v1/models",
        query: {
          capability: "tool_calling",
          curated: false,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
      });
      seen.push(...data.items.map((item) => item.modelId));
      cursor = data.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(nonCuratedModel);
    expect(seen).not.toContain("openrouter/qwen/qwen3.7-plus");
    expect(seen).not.toContain("openrouter/gryphe/mythomax-l2-13b");
  });
});
