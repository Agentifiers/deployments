import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { removeModelKey, setModelKey } from "./model-key-actions.ts";
import { loadModelKeys } from "./model-key-data.ts";
import {
  loadOrganizationSpend,
  loadOrganizationStanding,
  loadProjectSpend,
} from "./organization-account-data.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const ORG = "01K000000000000000000000G1";
const ALICE = "01K000000000000000000000A1";
const AT = "2026-10-09T12:00:00.000Z";
const scope = { organizationId: ORG };

interface Sent {
  readonly body: unknown;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly organization: string | null;
  readonly path: string;
}

function platform(respond: (path: string) => Response) {
  const sent: Sent[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      sent.push({
        body: request.body === null ? undefined : await request.json(),
        idempotencyKey: request.headers.get("idempotency-key"),
        method: request.method,
        organization: request.headers.get("x-deployments-organization"),
        path,
      });
      return respond(path);
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

const problem = (status: number, code: string) =>
  Response.json({ code, detail: code, status, title: "Request failed" }, { status });

function credential(provider: "openai" | "openrouter", status: "active" | "revoked" = "active") {
  return {
    createdAt: AT,
    credentialId: "01K000000000000000000000C1",
    keyVersion: 2,
    label: "Production",
    lastFour: "9xQz",
    provider,
    setAt: AT,
    setBy: ALICE,
    status,
    updatedAt: AT,
    version: 3,
  };
}

describe("model keys", () => {
  test("each provider reads as set, unset, or not enabled on the installation", async () => {
    const { client, sent } = platform((path) =>
      path.endsWith("/openai")
        ? Response.json(credential("openai"))
        : problem(404, "model_credentials_not_enabled"),
    );
    expect(await loadModelKeys("token", ORG, client)).toEqual([
      { label: "Production", lastFour: "9xQz", provider: "openai", setAt: AT, state: "set" },
      { provider: "openrouter", state: "not-enabled" },
    ]);
    expect(sent.map((request) => [request.method, request.path, request.organization])).toEqual([
      ["GET", `/v1/organizations/${ORG}/model-credentials/openai`, ORG],
      ["GET", `/v1/organizations/${ORG}/model-credentials/openrouter`, ORG],
    ]);

    const missing = platform((path) =>
      path.endsWith("/openai")
        ? problem(404, "model_credential_not_found")
        : Response.json(credential("openrouter", "revoked")),
    );
    expect(await loadModelKeys("token", ORG, missing.client)).toEqual([
      { provider: "openai", state: "unset" },
      { provider: "openrouter", state: "unset" },
    ]);
  });

  test("a refusal other than a missing key fails the read", async () => {
    const { client } = platform(() => problem(403, "insufficient_role"));
    const error = await loadModelKeys("token", ORG, client).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error instanceof PlatformApiError ? error.problem.code : error).toBe(
      "insufficient_role",
    );
  });

  test("saving sends the key once under the dialog's idempotency key and returns only its last four", async () => {
    const { client, sent } = platform(() => Response.json(credential("openai")));
    const saved = await setModelKey(
      {
        accessToken: "token",
        body: { apiKey: "sk-test-0123456789abcd9xQz", label: "Production" },
        idempotencyKey: "attempt-1",
        provider: "openai",
        scope,
      },
      client,
    );
    expect(saved).toEqual({
      label: "Production",
      lastFour: "9xQz",
      provider: "openai",
      setAt: AT,
      state: "set",
    });
    expect(sent).toEqual([
      {
        body: { apiKey: "sk-test-0123456789abcd9xQz", label: "Production" },
        idempotencyKey: "attempt-1",
        method: "PUT",
        organization: ORG,
        path: `/v1/organizations/${ORG}/model-credentials/openai`,
      },
    ]);
  });

  test("removing revokes the provider's key", async () => {
    const { client, sent } = platform(() => Response.json(credential("openrouter", "revoked")));
    expect(
      await removeModelKey(
        { accessToken: "token", idempotencyKey: "attempt-2", provider: "openrouter", scope },
        client,
      ),
    ).toEqual({ provider: "openrouter", state: "unset" });
    expect(sent.map((request) => [request.method, request.path, request.idempotencyKey])).toEqual([
      ["DELETE", `/v1/organizations/${ORG}/model-credentials/openrouter`, "attempt-2"],
    ]);
  });
});

test("standing holds reach the console with only their reason, customer message, and start", async () => {
  const { client } = platform(() =>
    Response.json({
      effective: {
        operatorFundedModelSpendCeiling: { monthlyUsdMicros: 0 },
        tenantLimits: {
          activeSandboxes: 2,
          apiRequestBurst: 50,
          apiRequestsPerSecond: 10,
          concurrentRuns: 2,
        },
      },
      holds: [
        {
          customerMessage: "Pay the overdue invoice to resume runs.",
          key: "overdue",
          operatorNote: "Card declined three times.",
          reason: "payment",
          since: AT,
          source: "service:billing",
        },
      ],
      organizationId: ORG,
      state: "suspended",
      suspendedAt: AT,
    }),
  );
  const standing = await loadOrganizationStanding("token", ORG, client);
  expect(standing.holds).toEqual([
    { customerMessage: "Pay the overdue invoice to resume runs.", reason: "payment", since: AT },
  ]);
});

test("a past month's spend and its project split are requested for that month", async () => {
  const PROJECT = "01K000000000000000000000P1";
  const requested: string[] = [];
  const split = { operatorFundedUsdMicros: 1, organizationFundedUsdMicros: 2, totalUsdMicros: 3 };
  const month = {
    asOf: AT,
    month: "2026-08",
    organizationId: ORG,
    periodStart: "2026-08-01T00:00:00.000Z",
  };
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requested.push(`${url.pathname}${url.search}`);
      return Response.json(
        url.pathname.endsWith("/projects")
          ? { ...month, items: [{ ...split, projectId: PROJECT }] }
          : { ...month, ...split, operatorFundedModelSpendCeiling: "unlimited" },
      );
    }) as typeof globalThis.fetch,
  });
  expect((await loadOrganizationSpend("token", ORG, "2026-08", client)).month).toBe("2026-08");
  const projects: unknown = await loadProjectSpend("token", ORG, "2026-08", client);
  expect(projects).toEqual([{ ...split, projectId: PROJECT }]);
  expect(requested).toEqual([
    `/v1/organizations/${ORG}/spend?month=2026-08`,
    `/v1/organizations/${ORG}/spend/projects?month=2026-08`,
  ]);
});
