import { describe, expect, test } from "bun:test";
import { createHttpApiV2Handler } from "./index.ts";

describe("HTTP API v2 adapter", () => {
  test("decodes the event body/query/cookies and maps the response", async () => {
    const handler = createHttpApiV2Handler(async (request) => {
      expect(await request.json()).toEqual({ hello: "world" });
      expect(new URL(request.url).searchParams.get("page")).toBe("2");
      expect(request.headers.get("cookie")).toBe("session=one");
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "next=two; Secure",
        },
      });
    });
    const result = await handler({
      body: Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
      cookies: ["session=one"],
      isBase64Encoded: true,
      rawPath: "/v1/example",
      rawQueryString: "page=2",
      requestContext: {
        domainName: "api.example",
        http: { method: "POST" },
      },
    });
    expect(result).toMatchObject({
      body: '{"ok":true}',
      cookies: ["next=two; Secure"],
      isBase64Encoded: false,
      statusCode: 201,
    });
  });
});
