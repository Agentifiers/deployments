import { describe, expect, test } from "bun:test";

import { pinnedFederationHttp } from "./pinned-http.ts";
import { failureCode } from "./testing/fake-identity-provider.ts";

describe("pinnedFederationHttp", () => {
  test("refuses non-https, credentialed, and non-public targets before connecting", async () => {
    const http = pinnedFederationHttp();
    const outcomes = await Promise.all(
      [
        "http://idp.example.com/.well-known/openid-configuration",
        Object.assign(new URL("https://idp.example.com/token"), { password: "p", username: "u" })
          .href,
        "https://127.0.0.1/token",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/token",
        "https://10.0.0.8/keys",
        "https://localhost/keys",
        "https://metadata.google.internal/keys",
      ].map((url) => failureCode(http({ headers: {}, method: "GET", url }))),
    );
    expect(outcomes).toEqual(Array(8).fill("idp_url_not_allowed"));
  });
});
