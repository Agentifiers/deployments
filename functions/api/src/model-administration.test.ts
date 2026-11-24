import { describe, expect, test } from "bun:test";
import { makeModelCatalogPersistence, type LoadModelOperatorGrants } from "@deployments-ai/db";
import { createAdministrationApi } from "./administration-api.ts";
import type { AdministrationEnvironment } from "./administration-persistence-contracts.ts";
import type { ApiIdentity } from "./index.ts";
import { isModelApiRouteName, makeModelAdministration } from "./model-administration.ts";
import {
  ENVIRONMENT,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  catalogEntry,
  generateId,
  memoryDatabase,
} from "./model-policy.fixture.ts";

interface ModelItem {
  readonly allowed: boolean;
  readonly curated: boolean;
  readonly modelId: string;
  readonly pricing?: unknown;
  readonly provider: string;
}

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

const LUNA = "openai/gpt-6-luna";

async function harness(
  scopes: readonly string[] = ["models:read", "models:write"],
  loadModelOperatorGrants?: LoadModelOperatorGrants,
) {
  const { database } = memoryDatabase();
  const catalog = makeModelCatalogPersistence(database);
  const hosted = [
    catalogEntry("openrouter/anthropic/claude-sonnet-4.6", {
      capabilities: {
        imageInput: true,
        reasoning: true,
        structuredOutputs: true,
        toolCalling: true,
      },
      displayName: "Anthropic: Claude Sonnet 4.6",
    }),
    catalogEntry("openrouter/meta-llama/llama-4-scout", {
      capabilities: {
        imageInput: false,
        reasoning: false,
        structuredOutputs: false,
        toolCalling: false,
      },
    }),
  ];
  await catalog.synchronizeProvider("openrouter", [
    ...hosted,
    catalogEntry("openrouter/retired/model"),
  ]);
  await catalog.synchronizeProvider("openrouter", hosted, { allowMassRetirement: true });
  await catalog.synchronizeProvider("openai", [catalogEntry("openai/gpt-4o"), catalogEntry(LUNA)]);
  const models = makeModelAdministration({
    database,
    environment: async () => ENVIRONMENT as unknown as AdministrationEnvironment,
    ...(loadModelOperatorGrants ? { loadModelOperatorGrants } : {}),
    generateId,
    now: () => new Date("2026-09-29T12:00:00.000Z"),
  });
  const identity = { environmentIds: [ENVIRONMENT_ID], principalId: PRINCIPAL_ID, scopes };
  const fetch = createAdministrationApi({
    authenticate: async () => identity satisfies ApiIdentity,
    authorize: async () => undefined,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "request_test",
    service: {
      invoke: async (routeName, invocation) => {
        if (!isModelApiRouteName(routeName)) throw new Error(`Unexpected route ${routeName}.`);
        return models.invoke(routeName, invocation);
      },
    },
  });
  let request = 0;
  return async (method: string, path: string, body?: unknown): Promise<CallResult> => {
    request += 1;
    const response = (await fetch(
      new Request(`https://api.example${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `model-test-${request}`,
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method,
      }),
    ))!;
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
}

function items(body: Record<string, unknown>) {
  return body.items as readonly ModelItem[];
}

describe("model administration", () => {
  test("lists synchronized and curated models with policy admission, filters, and cursors", async () => {
    const call = await harness();
    const all = await call("GET", "/v1/models?limit=100");
    expect(all.status).toBe(200);
    expect(all.body.policy).toEqual({ source: "curated_defaults" });
    const ids = items(all.body).map((item) => item.modelId);
    expect(ids).toEqual(ids.toSorted());
    expect(ids).not.toContain("openrouter/retired/model");
    expect(ids.filter((id) => id === "openai/gpt-4o")).toHaveLength(1);
    const byId = new Map(items(all.body).map((item) => [item.modelId, item]));
    expect(byId.get("openrouter/anthropic/claude-sonnet-4.6")).toMatchObject({
      allowed: false,
      curated: false,
      provider: "openrouter",
    });
    expect(byId.get("openai/gpt-4o")).toMatchObject({
      allowed: true,
      curated: true,
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    });

    const openRouter = await call("GET", "/v1/models?provider=openrouter");
    const openRouterProviders = items(openRouter.body).map((item) => item.provider);
    expect(openRouterProviders).toContain("openrouter");
    expect(openRouterProviders.every((provider) => provider === "openrouter")).toBe(true);
    const blocked = await call("GET", "/v1/models?curated=false&allowed=false");
    expect(items(blocked.body).map((item) => item.modelId)).toEqual([
      LUNA,
      "openrouter/anthropic/claude-sonnet-4.6",
      "openrouter/meta-llama/llama-4-scout",
    ]);
    const vision = await call("GET", "/v1/models?capability=image_input");
    expect(items(vision.body).map((item) => item.modelId)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.6",
    ]);
    const searched = await call("GET", "/v1/models?search=CLAUDE%20SONNET");
    expect(items(searched.body).map((item) => item.modelId)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.6",
    ]);

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: CallResult = await call(
        "GET",
        `/v1/models?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(items(page.body).length).toBeLessThanOrEqual(2);
      paged.push(...items(page.body).map((item) => item.modelId));
      cursor = page.body.nextCursor as string | null;
    } while (cursor);
    expect(paged).toEqual(ids);

    for (const query of ["provider=vertex", "allowed=yes", "capability=vision", "search="]) {
      const invalid = await call("GET", `/v1/models?${query}`);
      expect(invalid, query).toMatchObject({
        body: { code: "invalid_query_parameter" },
        status: 400,
      });
    }
    expect(await call("GET", "/v1/models?cursor=%21%21")).toMatchObject({
      body: { code: "invalid_cursor" },
      status: 400,
    });

    const policy = await call("POST", "/v1/model-policies", {
      includeCuratedModels: false,
      models: ["openrouter/*"],
      name: "Hosted catalog",
    });
    const governed = await call("GET", "/v1/models?limit=100");
    expect(governed.body.policy).toEqual({ modelPolicyId: policy.body.id, source: "model_policy" });
    const governedById = new Map(items(governed.body).map((item) => [item.modelId, item]));
    expect(governedById.get("openrouter/anthropic/claude-sonnet-4.6")?.allowed).toBe(true);
    expect(governedById.get("openai/gpt-4o")?.allowed).toBe(false);
  });

  test("marks models an operator grant admits for the environment's organization as allowed", async () => {
    const lunaAllowed = async (loadGrants?: LoadModelOperatorGrants) => {
      const call = await harness(undefined, loadGrants);
      const listed = await call("GET", `/v1/models?search=${encodeURIComponent(LUNA)}`);
      expect(listed.body.policy).toEqual({ source: "curated_defaults" });
      return items(listed.body).map((item) => [item.modelId, item.allowed]);
    };
    const grant = (organizationId: string) => async () => [
      { allowedModels: [LUNA], organizationId, providers: ["openai" as const] },
    ];
    expect(await lunaAllowed()).toEqual([[LUNA, false]]);
    expect(await lunaAllowed(async () => [])).toEqual([[LUNA, false]]);
    expect(await lunaAllowed(grant("*"))).toEqual([[LUNA, true]]);
    expect(await lunaAllowed(grant(ORGANIZATION_ID))).toEqual([[LUNA, true]]);
    expect(await lunaAllowed(grant("01ARZ3NDEKTSV4RRFFQ69G5FAZ"))).toEqual([[LUNA, false]]);
  });

  test("requires the models capability for the credential", async () => {
    const call = await harness(["tools:read", "tools:write"]);
    expect(await call("GET", "/v1/models")).toMatchObject({
      body: { code: "insufficient_scope" },
      status: 403,
    });
    const readOnly = await harness(["models:read"]);
    expect((await readOnly("GET", "/v1/model-policies")).status).toBe(200);
    expect(
      await readOnly("POST", "/v1/model-policies", {
        includeCuratedModels: true,
        models: [],
        name: "Defaults",
      }),
    ).toMatchObject({ body: { code: "insufficient_scope" }, status: 403 });
  });

  test("validates rules and holds one active policy per environment", async () => {
    const call = await harness();
    const unknown = await call("POST", "/v1/model-policies", {
      includeCuratedModels: true,
      models: ["openrouter/unknown/model", "bedrock/claude"],
      name: "Invalid",
    });
    expect(unknown).toMatchObject({ body: { code: "invalid_model_policy" }, status: 422 });
    expect(String(unknown.body.detail)).toContain("openrouter/unknown/model: ");
    expect(String(unknown.body.detail)).toContain("bedrock/claude: ");

    const created = await call("POST", "/v1/model-policies", {
      description: "Sonnet only",
      includeCuratedModels: true,
      models: ["openrouter/anthropic/claude-sonnet-4.6"],
      name: "Sonnet",
    });
    expect(created).toMatchObject({
      body: { includeCuratedModels: true, name: "Sonnet", status: "active", version: 1 },
      status: 201,
    });
    const id = String(created.body.id);
    expect(
      await call("POST", "/v1/model-policies", {
        includeCuratedModels: true,
        models: [],
        name: "Second",
      }),
    ).toMatchObject({ body: { code: "model_policy_exists" }, status: 409 });

    expect(
      await call("PATCH", `/v1/model-policies/${id}`, {
        expectedVersion: 1,
        includeCuratedModels: false,
        models: [],
      }),
    ).toMatchObject({ body: { code: "invalid_model_policy" }, status: 422 });
    const renamed = await call("PATCH", `/v1/model-policies/${id}`, {
      expectedVersion: 1,
      name: "Sonnet models",
    });
    expect(renamed).toMatchObject({
      body: {
        models: ["openrouter/anthropic/claude-sonnet-4.6"],
        name: "Sonnet models",
        version: 2,
      },
      status: 200,
    });
    expect((await call("GET", `/v1/model-policies/${id}`)).body).toEqual(renamed.body);

    const archived = await call("DELETE", `/v1/model-policies/${id}`, { expectedVersion: 2 });
    expect(archived).toMatchObject({
      body: { archivedAt: "2026-09-29T12:00:00.000Z", status: "archived", version: 3 },
      status: 200,
    });
    const replacement = await call("POST", "/v1/model-policies", {
      includeCuratedModels: true,
      models: ["openai/*"],
      name: "Replacement",
    });
    expect(replacement.status).toBe(201);
    const listed = await call("GET", "/v1/model-policies");
    expect(
      (listed.body.items as readonly { readonly status: string }[]).map((item) => item.status),
    ).toEqual(["archived", "active"]);
  });
});
