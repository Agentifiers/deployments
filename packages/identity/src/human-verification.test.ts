import { afterAll, describe, expect, test } from "bun:test";
import { makeSiteverifyHumanVerifier } from "./human-verification.ts";

const received: Record<string, string>[] = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    received.push(form);
    if (form.response === "provider-error") return new Response("unavailable", { status: 502 });
    if (form.response === "slow") return new Promise<Response>(() => undefined);
    if (form.response === "not-json") return new Response("<html>");
    return Response.json({ success: form.response === "valid" });
  },
});
afterAll(() => provider.stop(true));

const widget = {
  responseField: "challenge-response",
  scriptUrl: "https://challenge.example/api.js",
  siteKey: "site-key",
  widgetClass: "challenge",
  widgetOrigins: [],
};

function verifier(readSecret: () => Promise<string> = async () => "provider-secret") {
  return makeSiteverifyHumanVerifier({
    readSecret,
    timeoutMs: 100,
    verifyUrl: `http://127.0.0.1:${provider.port}/siteverify`,
    widget,
  });
}

describe("siteverify human verification", () => {
  test("posts the secret, response, and remote address and accepts success", async () => {
    received.length = 0;
    expect(await verifier().verify({ remoteIp: "203.0.113.7", response: "valid" })).toBe(
      "verified",
    );
    expect(received).toEqual([
      { remoteip: "203.0.113.7", response: "valid", secret: "provider-secret" },
    ]);
  });

  test("rejects a missing token without calling the provider", async () => {
    received.length = 0;
    const subject = verifier();
    expect(await subject.verify({ remoteIp: undefined, response: undefined })).toBe("rejected");
    expect(await subject.verify({ remoteIp: undefined, response: "valid" })).toBe("verified");
    expect(received).toEqual([{ response: "valid", secret: "provider-secret" }]);
  });

  test("rejects a token the provider refuses", async () => {
    expect(await verifier().verify({ remoteIp: undefined, response: "forged" })).toBe("rejected");
  });

  test("reports the provider unavailable on an error status, a timeout, or an unreadable reply", async () => {
    const subject = verifier();
    expect(
      await Promise.all(
        ["provider-error", "slow", "not-json"].map((response) =>
          subject.verify({ remoteIp: undefined, response }),
        ),
      ),
    ).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  test("reads the secret once and retries a failed read on the next request", async () => {
    const reads: string[] = [];
    const subject = verifier(async () => {
      reads.push("read");
      if (reads.length === 1) throw new Error("parameter store is unreachable");
      return "provider-secret";
    });

    const outcomes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      outcomes.push(await subject.verify({ remoteIp: undefined, response: "valid" }));
    }

    expect(outcomes).toEqual(["unavailable", "verified", "verified"]);
    expect(reads).toEqual(["read", "read"]);
  });
});
