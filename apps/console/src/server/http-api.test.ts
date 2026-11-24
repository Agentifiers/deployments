import { describe, expect, test } from "bun:test";
import { httpApiRequest, httpApiResult } from "./http-api.ts";

const PUBLIC_ORIGIN = "https://app.example.com";

describe("httpApiRequest", () => {
  test("restores cookies, method, and body from a payload 2.0 event", async () => {
    const request = httpApiRequest(
      {
        body: Buffer.from("returnTo=%2F").toString("base64"),
        cookies: ["__Host-deployments-session=a", "theme=dark"],
        headers: { "content-type": "application/x-www-form-urlencoded" },
        isBase64Encoded: true,
        rawPath: "/auth/logout",
        rawQueryString: "next=1",
        requestContext: { http: { method: "POST" } },
      },
      PUBLIC_ORIGIN,
    );
    expect(request.url).toBe(`${PUBLIC_ORIGIN}/auth/logout?next=1`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("cookie")).toBe("__Host-deployments-session=a; theme=dark");
    expect(await request.text()).toBe("returnTo=%2F");
  });

  test("uses the public origin, not the execute-api host CloudFront forwards", () => {
    const request = httpApiRequest(
      {
        headers: {
          host: "abc.execute-api.us-east-2.amazonaws.com",
          "x-forwarded-host": "abc.execute-api.us-east-2.amazonaws.com",
          "x-forwarded-proto": "http",
        },
        rawPath: "/o/01K0000000000000000000000A",
        rawQueryString: "workspace=01K0000000000000000000000B",
        requestContext: {
          domainName: "abc.execute-api.us-east-2.amazonaws.com",
          http: { method: "GET" },
        },
      },
      PUBLIC_ORIGIN,
    );
    expect(request.url).toBe(
      `${PUBLIC_ORIGIN}/o/01K0000000000000000000000A?workspace=01K0000000000000000000000B`,
    );
    expect(request.headers.get("host")).toBe("app.example.com");
    expect(request.headers.get("x-forwarded-host")).toBeNull();
  });

  test("keeps protocol-relative raw paths on the public origin and drops GET bodies", () => {
    const request = httpApiRequest(
      { body: "ignored", rawPath: "//evil.example/x", requestContext: { http: { method: "GET" } } },
      PUBLIC_ORIGIN,
    );
    expect(new URL(request.url).origin).toBe(PUBLIC_ORIGIN);
    expect(request.body).toBeNull();
  });
});

describe("httpApiResult", () => {
  test("returns Set-Cookie values only through cookies", async () => {
    const headers = new Headers({ "content-type": "text/html; charset=utf-8", location: "/" });
    headers.append("set-cookie", "a=1; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", "b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    const result = await httpApiResult(new Response("<p>ok</p>", { headers, status: 302 }));
    expect(result).toEqual({
      body: "<p>ok</p>",
      cookies: ["a=1; Path=/; Secure; HttpOnly", "b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
      headers: { "content-type": "text/html; charset=utf-8", location: "/" },
      isBase64Encoded: false,
      statusCode: 302,
    });
  });

  test("base64-encodes binary bodies", async () => {
    const result = await httpApiResult(
      new Response(new Uint8Array([0, 255]), { headers: { "content-type": "font/woff2" } }),
    );
    expect(result).toMatchObject({ body: "AP8=", isBase64Encoded: true });
    expect(result.cookies).toBeUndefined();
  });
});
