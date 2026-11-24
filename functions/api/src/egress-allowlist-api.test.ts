import {
  OrganizationRecord,
  makeOrganizationEgressAllowlistRepository,
  withCanonicalRecordKeys,
  type OrganizationRole,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { createEgressAllowlistApi } from "./egress-allowlist-api.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PERSON = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const ADMINISTRATOR = "01ARZ3NDEKTSV4RRFFQ69G5FB3";

const human = (organizationRole: OrganizationRole, scopes = ["governance:*"]): ApiIdentity => ({
  authentication: "tenant-jwt",
  organizationIds: [ORG],
  organizationRole,
  principalId: PERSON,
  scopes,
});

const IDENTITIES: Readonly<Record<string, ApiIdentity>> = {
  admin: human("admin"),
  "api-key": {
    authentication: "api-credential",
    organizationIds: [ORG],
    principalId: PERSON,
    scopes: ["governance:write", "governance:read"],
  },
  member: human("member"),
  operator: {
    authentication: "tenant-jwt",
    operatorAccess: operatorAccessGrant(ORG),
    organizationIds: [ORG],
    platformRole: "administrator",
    principalId: ADMINISTRATOR,
    scopes: ["platform:*"],
  },
  owner: human("owner"),
  "owner-read-only": human("owner", ["governance:read"]),
  viewer: human("viewer"),
};

function setup() {
  const memory = evaluationMemoryDatabase([
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: ORG,
          name: "Acme Health",
          slug: "acme-health",
          status: "active",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  ]);
  const replays = new Map<string, { fingerprint: string; result: unknown }>();
  const handler = createEgressAllowlistApi({
    authenticate: async (request) => IDENTITIES[request.headers.get("authorization") ?? ""] ?? null,
    idempotency: {
      execute: async (input) => {
        const stored = replays.get(`${input.principalId}:${input.key}`);
        if (stored) {
          if (stored.fingerprint !== input.fingerprint) throw new Error("fingerprint mismatch");
          return stored.result;
        }
        const result = await input.operation();
        replays.set(`${input.principalId}:${input.key}`, {
          fingerprint: input.fingerprint,
          result,
        });
        return result;
      },
    },
    repository: makeOrganizationEgressAllowlistRepository(memory.database),
    requestId: () => "req-test",
  });
  let keys = 0;
  const send = async (
    caller: string,
    method: "GET" | "PUT",
    body?: unknown,
    idempotencyKey = `key-${++keys}`,
  ) => {
    const response = await handler(
      new Request(`https://api.example.test/v1/organizations/${ORG}/egress-allowlist`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: caller,
          "x-deployments-organization": ORG,
          ...(method === "PUT" ? { "idempotency-key": idempotencyKey } : {}),
        },
        method,
      }),
    );
    if (!response) throw new Error("The allowlist API did not handle the request.");
    return { body: (await response.json()) as Record<string, any>, status: response.status };
  };
  const events = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "semantic-event" ? [[record.data.eventType, record.data.payload]] : [],
      );
  return { events, memory, send };
}

const TWO = {
  entries: [
    { note: "Claims clearinghouse", origin: "https://claims.example.com" },
    { origin: "https://labs.example.org" },
  ],
};

describe("organization egress allowlist API", () => {
  test("an owner sets the list and reads it back; an admin may too", async () => {
    const { events, send } = setup();

    const set = await send("owner", "PUT", TWO);
    const read = await send("viewer", "GET");
    const admin = await send("admin", "PUT", { entries: [{ origin: "https://labs.example.org" }] });

    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      allowlist: {
        entries: TWO.entries,
        organizationId: ORG,
        updatedAt: expect.any(String),
        updatedByPrincipalId: PERSON,
        version: 1,
      },
      changed: true,
    });
    expect(read).toEqual({ body: set.body.allowlist, status: 200 });
    expect(admin.body).toMatchObject({ allowlist: { version: 2 }, changed: true });
    expect(events()).toEqual([
      [
        "organization.egress-allowlist-updated",
        { added: ["https://claims.example.com", "https://labs.example.org"], removed: [] },
      ],
      [
        "organization.egress-allowlist-updated",
        { added: [], removed: ["https://claims.example.com"] },
      ],
    ]);
  });

  test("a missing list reads as empty version 0", async () => {
    const { send } = setup();
    expect(await send("member", "GET")).toEqual({
      body: {
        entries: [],
        organizationId: ORG,
        updatedAt: null,
        updatedByPrincipalId: null,
        version: 0,
      },
      status: 200,
    });
  });

  test("members, viewers, and a token without governance:write get 403 and nothing is written", async () => {
    const { memory, send } = setup();

    const refusals = [];
    for (const caller of ["member", "viewer", "owner-read-only"]) {
      const response = await send(caller, "PUT", TWO);
      refusals.push([caller, response.status, response.body.code]);
    }

    expect(refusals).toEqual([
      ["member", 403, "insufficient_role"],
      ["viewer", 403, "insufficient_role"],
      ["owner-read-only", 403, "insufficient_scope"],
    ]);
    expect(memory.transactions).toHaveLength(0);
  });

  test("an API key with governance:write gets 403 insufficient_role, but may read", async () => {
    const { memory, send } = setup();

    const write = await send("api-key", "PUT", TWO);
    const read = await send("api-key", "GET");

    expect([write.status, write.body.code]).toEqual([403, "insufficient_role"]);
    expect(read.status).toBe(200);
    expect(memory.transactions).toHaveLength(0);
  });

  test("an administrator under operator access may write", async () => {
    const { events, send } = setup();
    expect(
      (await send("operator", "PUT", { entries: [{ origin: "https://a.example.com" }] })).status,
    ).toBe(200);
    expect(events()).toHaveLength(1);
  });

  test.each([
    ["http", { entries: [{ origin: "http://a.example.com" }] }, "/entries/0/origin"],
    ["path", { entries: [{ origin: "https://a.example.com/v1" }] }, "/entries/0/origin"],
    ["query", { entries: [{ origin: "https://a.example.com?x=1" }] }, "/entries/0/origin"],
    ["credentials", { entries: [{ origin: "https://u:p@a.example.com" }] }, "/entries/0/origin"],
    ["wildcard", { entries: [{ origin: "https://*.example.com" }] }, "/entries/0/origin"],
    ["not normalized", { entries: [{ origin: "https://A.example.com:443" }] }, "/entries/0/origin"],
    [
      "duplicate",
      { entries: [{ origin: "https://a.example.com" }, { origin: "https://a.example.com" }] },
      "/entries/1/origin",
    ],
    [
      "long note",
      { entries: [{ note: "n".repeat(201), origin: "https://a.example.com" }] },
      "/entries/0/note",
    ],
    [
      "too many",
      {
        entries: Array.from({ length: 201 }, (_, index) => ({
          origin: `https://h${index}.example.com`,
        })),
      },
      "/entries",
    ],
    ["unknown field", { entries: [], extra: true }, "/extra"],
    ["missing origin", { entries: [{ note: "x" }] }, "/entries/0/origin"],
  ] as const)("rejects %s with 400 and a pointer", async (_, body, pointer) => {
    const { memory, send } = setup();
    const response = await send("owner", "PUT", body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_egress_allowlist", pointer });
    expect(memory.transactions).toHaveLength(0);
  });

  test("a retry under the same key replays the answer and writes once", async () => {
    const { memory, send } = setup();

    const first = await send("owner", "PUT", TWO, "same-key");
    const retry = await send("owner", "PUT", TWO, "same-key");

    expect(retry).toEqual(first);
    expect(memory.transactions).toHaveLength(1);
  });

  test("the same list under a new key answers changed: false and writes nothing", async () => {
    const { memory, send } = setup();
    await send("owner", "PUT", TWO);
    const again = await send("owner", "PUT", {
      entries: [...TWO.entries].reverse(),
    });
    expect(again.body).toMatchObject({ allowlist: { version: 1 }, changed: false });
    expect(memory.transactions).toHaveLength(1);
  });

  test("refuses a write without an idempotency key", async () => {
    const { memory, send } = setup();
    const missingKey = await send("owner", "PUT", TWO, "");
    expect([missingKey.status, missingKey.body.code]).toEqual([400, "missing_idempotency_key"]);
    expect(memory.transactions).toHaveLength(0);
  });
});
