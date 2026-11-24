import { expect, test } from "bun:test";
import { readCookie, serializeBffCookie, WEB_BFF_SESSION_COOKIE } from "./cookies.ts";

test("reads semicolon- and comma-joined cookie headers", () => {
  const name = WEB_BFF_SESSION_COOKIE;
  expect(readCookie(`a=1; ${name}=abc_-9; b=2`, name)).toBe("abc_-9");
  // API Gateway v2 cookies re-joined by the Lambda adapter with `Headers.append`.
  expect(readCookie(`__Host-deployments-authorization=x, ${name}=abc`, name)).toBe("abc");
  expect(readCookie(`${name}=one; ${name}=two`, name)).toBeUndefined();
  expect(readCookie(`${name}=`, name)).toBeUndefined();
  expect(readCookie(undefined, name)).toBeUndefined();
});

test("serializes host-only HttpOnly Secure Lax cookies", () => {
  expect(serializeBffCookie(WEB_BFF_SESSION_COOKIE, "v", 10.9)).toBe(
    "__Host-deployments-session=v; Max-Age=10; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  expect(serializeBffCookie(WEB_BFF_SESSION_COOKIE, "", -5)).toContain("Max-Age=0;");
});
