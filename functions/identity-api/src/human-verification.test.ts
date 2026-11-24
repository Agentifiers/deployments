import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { makeSiteverifyHumanVerifier, sha256 } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import { makeIdentityHttpHandler } from "./http.ts";
import type { QueuedPublicEmailRequest } from "./public-email-requests.ts";

const verifications: Record<string, string>[] = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    verifications.push(form);
    if (form.response === "provider-error") return new Response("unavailable", { status: 503 });
    if (form.response === "provider-timeout") return new Promise<Response>(() => undefined);
    return Response.json({ success: form.response === "human-token" });
  },
});
afterAll(() => provider.stop(true));

const widget = {
  responseField: "challenge-response",
  scriptUrl: "https://challenge.example/v1/api.js",
  siteKey: "site-key-1",
  widgetClass: "challenge",
  widgetOrigins: [],
};

function handlerWith(input: { readonly verified: boolean; readonly widgetOrigins?: string[] }) {
  const queued: QueuedPublicEmailRequest[] = [];
  const handler = makeIdentityHttpHandler({} as IdentityApplication, {
    applicationOrigin: "https://app.deployments.ai",
    ...(input.verified
      ? {
          humanVerifier: makeSiteverifyHumanVerifier({
            readSecret: async () => "provider-secret",
            timeoutMs: 100,
            verifyUrl: `http://127.0.0.1:${provider.port}/siteverify`,
            widget: { ...widget, widgetOrigins: input.widgetOrigins ?? [] },
          }),
        }
      : {}),
    issuer: "https://auth.deployments.ai",
    publicResponseMinimumMs: 40,
    queuePublicEmailRequest: async (request) => {
      queued.push(request);
    },
    registrationEnabled: true,
    secureCookies: true,
    uiOrigin: "https://auth.deployments.ai",
  });
  return { handler, queued };
}

function submit(path: string, body: Record<string, string>) {
  return {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: "__Host-dpl_csrf=csrf-token",
      origin: "https://auth.deployments.ai",
      "x-csrf-token": "csrf-token",
    },
    httpMethod: "POST",
    path,
    requestContext: { identity: { sourceIp: "203.0.113.42" } },
  };
}

async function policyAndBody(path: string, input: Parameters<typeof handlerWith>[0]) {
  const page = await handlerWith(input).handler({ httpMethod: "GET", path });
  return {
    body: page.body,
    policy: page.headers["Content-Security-Policy"]?.replace(/'nonce-[^']+'/gu, "'nonce-N'"),
  };
}

describe("human verification pages", () => {
  test("renders the configured widget in the sign-up and forgot forms and allows only its origin", async () => {
    const page = await policyAndBody("/sign-up", { verified: true });

    expect(page.policy).toBe(
      "default-src 'none'; script-src 'nonce-N' https://challenge.example; style-src 'nonce-N'; connect-src 'self'; frame-src https://challenge.example; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(page.body).toContain(
      '<title>Deployments.ai identity</title><script src="https://challenge.example/v1/api.js" async defer></script>',
    );
    expect(page.body).toContain(
      'required></label><div class="challenge" data-sitekey="site-key-1"></div><button type="submit">Send verification email</button>',
    );
    expect(page.body).toContain(
      'required></label><div class="challenge" data-sitekey="site-key-1"></div><button type="submit">Send reset email</button>',
    );
  });

  test("adds configured widget origins to the script, style, connect, and frame sources", async () => {
    const page = await policyAndBody("/sign-in", {
      verified: true,
      widgetOrigins: ["https://widget.example", "https://*.widget.example"],
    });

    expect(page.policy).toBe(
      "default-src 'none'; script-src 'nonce-N' https://challenge.example https://widget.example https://*.widget.example; style-src 'nonce-N' https://widget.example https://*.widget.example; connect-src 'self' https://widget.example https://*.widget.example; frame-src https://challenge.example https://widget.example https://*.widget.example; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  test("keeps today's page and policy when no verification is configured", async () => {
    const page = await policyAndBody("/sign-up", { verified: false });

    expect(page.policy).toBe(
      "default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(page.body).toContain(
      'required></label><button type="submit">Send verification email</button>',
    );
    expect(page.body).toContain('<title>Deployments.ai identity</title><style nonce="');
  });
});

describe.each([
  ["/v1/auth/sign-up", "sign-up"],
  ["/v1/auth/password/forgot", "password-recovery"],
] as const)("human verification on %s", (path, operation) => {
  const rejected = {
    body: {
      error: "human_verification_failed",
      error_description: "Complete the human verification check and try again.",
    },
    logged: [],
    statusCode: 400,
  };
  const unavailable = {
    body: { error: "temporarily_unavailable" },
    logged: [
      [
        "A public identity email request failed after generic acceptance.",
        { errorType: "HumanVerificationUnavailable", operation },
      ],
    ],
    statusCode: 503,
  };

  test.each([
    ["a missing token", {}, rejected, []],
    ["a rejected token", { "challenge-response": "forged" }, rejected, ["forged"]],
    [
      "a provider error",
      { "challenge-response": "provider-error" },
      unavailable,
      ["provider-error"],
    ],
    [
      "a provider timeout",
      { "challenge-response": "provider-timeout" },
      unavailable,
      ["provider-timeout"],
    ],
  ])(
    "refuses %s, enqueues nothing, and keeps the response floor",
    async (_case, token, expected, sent) => {
      verifications.length = 0;
      const { handler, queued } = handlerWith({ verified: true });
      const logs = spyOn(console, "error").mockImplementation(() => undefined);
      const started = performance.now();

      const response = await handler(submit(path, { email: "person@example.com", ...token }));
      const logged = [...logs.mock.calls];
      logs.mockRestore();

      expect(performance.now() - started).toBeGreaterThanOrEqual(35);
      expect({ body: JSON.parse(response.body), logged, statusCode: response.statusCode }).toEqual(
        expected,
      );
      expect(queued).toEqual([]);
      expect(verifications.map((form) => form.response)).toEqual(sent);
    },
  );

  test("enqueues a verified request after the response floor", async () => {
    verifications.length = 0;
    const { handler, queued } = handlerWith({ verified: true });
    const started = performance.now();

    const response = await handler(
      submit(path, { "challenge-response": "human-token", email: "person@example.com" }),
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    expect({ body: JSON.parse(response.body), statusCode: response.statusCode }).toEqual({
      body: { accepted: true },
      statusCode: 202,
    });
    expect(verifications).toEqual([
      { remoteip: "203.0.113.42", response: "human-token", secret: "provider-secret" },
    ]);
    expect(queued).toEqual([
      { email: "person@example.com", operation, sourcePrefixHash: sha256("203.0.113") },
    ]);
  });

  test("enqueues without a token when no verification is configured", async () => {
    const { handler, queued } = handlerWith({ verified: false });

    const response = await handler(submit(path, { email: "person@example.com" }));

    expect(response.statusCode).toBe(202);
    expect(queued).toEqual([
      { email: "person@example.com", operation, sourcePrefixHash: sha256("203.0.113") },
    ]);
  });
});
