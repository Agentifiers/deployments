import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gatewayHarness, INDEX_HTML, MEMBER, type GatewayHarness } from "./test-support.ts";

const STANDING_CACHE_MS = 5_001;

let h: GatewayHarness;

beforeAll(async () => {
  h = await gatewayHarness();
});

afterAll(async () => {
  await h.stop();
});

describe("apps of a suspended organization", () => {
  test("answer members and visitors with a neutral 503 until every hold is released", async () => {
    const created = await h.activeApp({ access: "viewer", name: "Suspended" });
    const { app: released } = await h.release(created, INDEX_HTML, true);
    const app = await h.publish(released, "public");
    const member = h.browser();
    await h.signIn(member, app, MEMBER);
    const visitor = h.browser();
    const observe = async () => {
      const responses = {
        "member me": await member.request(app, "/_platform/me"),
        "member page": await member.request(app, "/"),
        "visitor api": await visitor.request(app, "/_platform/api/sign_up", {
          body: '{"p_email":"guest@example.com"}',
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          method: "POST",
        }),
        "visitor page": await visitor.request(app, "/"),
      };
      return {
        bodies: {
          api: await responses["visitor api"].clone().text(),
          page: await responses["visitor page"].clone().text(),
        },
        statuses: Object.fromEntries(
          Object.entries(responses).map(([name, response]) => [
            name,
            `${response.status} retry-after=${response.headers.get("retry-after")}`,
          ]),
        ),
      };
    };
    const serving = {
      "member me": "200 retry-after=null",
      "member page": "200 retry-after=null",
      "visitor api": "200 retry-after=null",
      "visitor page": "200 retry-after=null",
    };

    const before = await observe();
    await h.holds.place("payment");
    h.advance(STANDING_CACHE_MS);
    const held = await observe();
    await h.holds.release("payment");
    h.advance(STANDING_CACHE_MS);
    const after = await observe();

    expect([before.statuses, held.statuses, after.statuses]).toEqual([
      serving,
      {
        "member me": "503 retry-after=300",
        "member page": "503 retry-after=300",
        "visitor api": "503 retry-after=300",
        "visitor page": "503 retry-after=300",
      },
      serving,
    ]);
    expect(JSON.parse(held.bodies.api)).toEqual({
      error: {
        code: "app_unavailable",
        message: "This app is temporarily unavailable. Try again later.",
      },
    });
    expect(held.bodies.page).toContain(
      "<h1>App unavailable</h1><p>This app is temporarily unavailable. Try again later.</p>",
    );
    expect(held.bodies.page).not.toMatch(/suspend|hold|payment/iu);
  });
});
