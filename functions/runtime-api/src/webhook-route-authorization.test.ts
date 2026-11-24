import { describe, expect, test } from "bun:test";
import { webhookApiFixture } from "./webhook-api.fixture.ts";

function seeded(options: Parameters<typeof webhookApiFixture>[0]) {
  const fixture = webhookApiFixture(options);
  const endpoint = fixture.seedEndpoint();
  const delivery = fixture.seedDelivery(endpoint.data.id);
  fixture.seedAttempt(delivery, 1);
  const webhook = `/v1/webhooks/${endpoint.data.id}`;
  const deliveryPath = `/v1/webhook-deliveries/${delivery.data.id}`;
  return {
    fixture,
    mutations: [
      ["PATCH", webhook, { name: "Renamed" }],
      ["POST", `${webhook}/disable`, undefined],
      ["POST", `${webhook}/enable`, undefined],
      ["POST", `${webhook}/rotate-secret`, {}],
      ["POST", `${webhook}/test`, undefined],
      ["POST", `${deliveryPath}/retry`, undefined],
    ] as const,
    reads: [
      ["GET", webhook],
      ["GET", "/v1/webhook-deliveries?status=failed"],
      ["GET", deliveryPath],
      ["GET", `${deliveryPath}/attempts`],
    ] as const,
  };
}

describe("webhook route authorization", () => {
  test("a webhooks:read credential reads but cannot mutate", async () => {
    const { fixture, mutations, reads } = seeded({ credentialScopes: ["webhooks:read"] });
    for (const [method, path] of reads) {
      expect(await fixture.request(method, path)).toMatchObject({ status: 200 });
    }
    for (const [method, path, body] of mutations) {
      expect(await fixture.request(method, path, body)).toMatchObject({
        body: { code: "insufficient_scope" },
        status: 403,
      });
    }
    expect(fixture.enqueued).toEqual([]);
    expect(fixture.memory.transactions).toEqual([]);
  });

  test("a credential without webhook scopes cannot read webhooks or deliveries", async () => {
    const { fixture, reads } = seeded({ credentialScopes: ["runs:read"] });
    for (const [method, path] of reads) {
      expect(await fixture.request(method, path)).toMatchObject({
        body: { code: "insufficient_scope" },
        status: 403,
      });
    }
  });

  test("organization members read while only mutating roles change webhooks", async () => {
    const { fixture: member, ...memberRoutes } = seeded({ humanRole: "member" });
    for (const [method, path] of memberRoutes.reads) {
      expect(await member.request(method, path, undefined, "human")).toMatchObject({ status: 200 });
    }
    for (const [method, path, body] of memberRoutes.mutations) {
      expect(await member.request(method, path, body, "human")).toMatchObject({
        body: { code: "insufficient_role" },
        status: 403,
      });
    }

    const { fixture: admin, ...adminRoutes } = seeded({ humanRole: "admin" });
    expect(
      await admin.request("PATCH", adminRoutes.mutations[0][1], { name: "Renamed" }, "human"),
    ).toMatchObject({ body: { name: "Renamed" }, status: 200 });
  });
});
