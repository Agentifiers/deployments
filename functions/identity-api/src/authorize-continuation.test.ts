import { expect, test } from "bun:test";
import { safeReturnTo } from "./authorize-continuation.ts";

test("safeReturnTo admits only same-origin /oauth2/authorize continuations", () => {
  const admitted: (string | undefined)[] = [
    "/oauth2/authorize?client_id=deployments-apps&state=s",
    "/oauth2/authorize#fragment",
    "/oauth2/token/../authorize?a=1",
    "https://evil.example/oauth2/authorize",
    "//evil.example/oauth2/authorize",
    "/\\evil.example/oauth2/authorize",
    "/oauth2/authorize/../token",
    "/oauth2/authorizex",
    "/sign-in?return_to=/oauth2/authorize",
    "javascript:alert(1)",
    "",
    undefined,
  ].map(safeReturnTo);
  expect(admitted).toEqual([
    "/oauth2/authorize?client_id=deployments-apps&state=s",
    "/oauth2/authorize#fragment",
    "/oauth2/authorize?a=1",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});
