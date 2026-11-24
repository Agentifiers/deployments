import { describe, expect, it } from "bun:test";
import { createPlatformSdk, PlatformRequestError, PlatformTransportError } from "./index.ts";

function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body);
}

describe("platform SDK request transport", () => {
  it("sends scoped API requests with query, body, auth, and idempotency headers", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      requestInit = init;
      return new Response(JSON.stringify({ id: "prj_1" }), {
        status: 201,
        headers: { "content-type": "application/json", "x-request-id": "req_1" },
      });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({
      baseUrl: "https://api.example.test",
      apiKey: "dpl_secret",
      fetch: fetchImpl,
      userAgent: "test-cli",
    });
    const response = await sdk.request({
      method: "POST",
      path: "/v1/projects",
      context: { organizationId: "org_1", projectId: "prj_1", environmentId: "env_1" },
      query: { dryRun: true },
      body: { name: "Example" },
      idempotencyKey: "idem_1",
    });
    expect(requestUrl).toBe("https://api.example.test/v1/projects?dryRun=true");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer dpl_secret");
    expect(headers.get("idempotency-key")).toBe("idem_1");
    expect(headers.get("x-deployments-environment")).toBe("env_1");
    expect(requestInit?.body).toBe(JSON.stringify({ name: "Example" }));
    expect(requestInit?.redirect).toBe("error");
    expect(response).toEqual({ data: { id: "prj_1" }, requestId: "req_1", mocked: false });
  });

  it("sends the exact content length for raw upload bodies", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return Response.json({ status: "completed" });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const rawBody = new TextEncoder().encode("Brain evidence");

    await sdk.request({
      contentType: "text/markdown",
      method: "PUT",
      path: "/v1/brains/brain_1/sources/source_1/uploads/ticket_1/content",
      rawBody,
    });

    const headers = new Headers(requestInit?.headers);
    expect(headers.get("content-length")).toBe(String(rawBody.byteLength));
    expect(headers.get("content-type")).toBe("text/markdown");
    expect(requestInit?.body).toBe(rawBody);
  });

  it("bridges custom-domain lifecycle requests through the bounded agent-email API", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return Response.json(
        { id: "domain_1", domain: "agents.customer.example" },
        {
          headers: { "x-request-id": "req_email_domain" },
        },
      );
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const email = sdk.agentEmail({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    await email.domains.create(
      { domain: "agents.customer.example", placementId: "placement_1" },
      { idempotencyKey: "idem_domain_create" },
    );
    await email.domains.refresh("domain with separator", { idempotencyKey: "idem_refresh" });
    await email.domains.revoke("domain_1", { idempotencyKey: "idem_revoke" });

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://api.example.test/v1/agent-email/domains"],
      ["POST", "https://api.example.test/v1/agent-email/domains/domain%20with%20separator/refresh"],
      ["POST", "https://api.example.test/v1/agent-email/domains/domain_1/revoke"],
    ]);
    expect(jsonBody(requests[0]?.init)).toEqual({
      domain: "agents.customer.example",
      placementId: "placement_1",
    });
    expect(new Headers(requests[0]?.init?.headers).get("x-deployments-organization")).toBe("org_1");
    expect(new Headers(requests[0]?.init?.headers).get("idempotency-key")).toBe(
      "idem_domain_create",
    );
  });

  it("bridges inbox message, draft, and query operations", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return Response.json({ id: "email_1" });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const email = sdk.agentEmail({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    await email.inboxes.list({ clientId: "client_1", limit: 25, status: "active" });
    await email.messages.send(
      "inbox_1",
      { subject: "Status", text: "Ready", to: ["owner@example.com"] },
      { idempotencyKey: "idem_send" },
    );
    await email.drafts.create(
      "inbox_1",
      { subject: "Draft", text: "Review", to: ["owner@example.com"] },
      { idempotencyKey: "idem_draft" },
    );
    await email.attachments.accessUrl("attachment_1");

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      [
        "GET",
        "https://api.example.test/v1/agent-email/inboxes?clientId=client_1&limit=25&status=active",
      ],
      ["POST", "https://api.example.test/v1/agent-email/inboxes/inbox_1/messages"],
      ["POST", "https://api.example.test/v1/agent-email/inboxes/inbox_1/drafts"],
      ["POST", "https://api.example.test/v1/agent-email/attachments/attachment_1/access-url"],
    ]);
    expect(jsonBody(requests[1]?.init)).toEqual({
      subject: "Status",
      text: "Ready",
      to: ["owner@example.com"],
    });
    expect(new Headers(requests[1]?.init?.headers).get("idempotency-key")).toBe("idem_send");
  });

  it("bridges inbox binding CRUD with the complete environment hierarchy", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return Response.json({ id: "binding_1" });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const email = sdk.agentEmail({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    await email.bindings.create(
      "inbox_1",
      { agentDeploymentId: "deployment_1", bindingType: "platform_agent" },
      { idempotencyKey: "idem_binding_create" },
    );
    await email.bindings.list("inbox_1", { limit: 25 });
    await email.bindings.get("binding_1");
    await email.bindings.delete("binding_1", { idempotencyKey: "idem_binding_delete" });

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://api.example.test/v1/agent-email/inboxes/inbox_1/bindings"],
      ["GET", "https://api.example.test/v1/agent-email/inboxes/inbox_1/bindings?limit=25"],
      ["GET", "https://api.example.test/v1/agent-email/bindings/binding_1"],
      ["DELETE", "https://api.example.test/v1/agent-email/bindings/binding_1"],
    ]);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("x-deployments-organization")).toBe("org_1");
    expect(headers.get("x-deployments-project")).toBe("prj_1");
    expect(headers.get("x-deployments-environment")).toBe("env_1");
    expect(headers.get("idempotency-key")).toBe("idem_binding_create");
  });

  it("rejects absolute and network-path URLs before attaching credentials", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({
      baseUrl: "https://api.example.test",
      apiKey: "dpl_secret",
      fetch: fetchImpl,
    });
    expect(
      sdk.request({ method: "GET", path: "https://attacker.example/collect" }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({ method: "GET", path: "//attacker.example/collect" }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(fetchCalls).toBe(0);
  });

  it("normalizes malformed base URLs as request validation errors", async () => {
    const sdk = createPlatformSdk({ baseUrl: "not-a-url" });
    expect(sdk.request({ method: "GET", path: "/v1/health" })).rejects.toBeInstanceOf(
      PlatformRequestError,
    );

    for (const baseUrl of [
      "https://api.example.test/prefix",
      "https://api.example.test/?tenant=one",
      "https://api.example.test/#fragment",
      "https://user:password@api.example.test/",
    ]) {
      const invalid = createPlatformSdk({ baseUrl });
      expect(invalid.request({ method: "GET", path: "/v1/health" })).rejects.toBeInstanceOf(
        PlatformRequestError,
      );
    }
  });

  it("requires TLS for all non-loopback API hosts", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const insecure = createPlatformSdk({
      baseUrl: "http://api.example.test",
      apiKey: "dpl_secret",
      fetch: fetchImpl,
    });
    expect(insecure.request({ method: "GET", path: "/v1/health" })).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
    expect(fetchCalls).toBe(0);

    const unauthenticated = createPlatformSdk({
      baseUrl: "http://api.example.test",
      fetch: fetchImpl,
    });
    expect(
      unauthenticated.request({ method: "POST", path: "/v1/credentials", body: { secret: "x" } }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(fetchCalls).toBe(0);

    const loopback = createPlatformSdk({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "dpl_secret",
      fetch: fetchImpl,
    });
    expect(loopback.request({ method: "GET", path: "/v1/health" })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(fetchCalls).toBe(1);
  });

  it("normalizes public problem details", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ title: "Forbidden", status: 403, code: "environment_scope_violation" }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 403, code: "environment_scope_violation" },
    });
  });

  it("preserves RFC 9457 problem instance identifiers", async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          instance: "/v1/problems/01ARZ3NDEKTSV4RRFFQ69G5FB5",
          status: 409,
          title: "Conflict",
        },
        { status: 409, headers: { "content-type": "application/problem+json" } },
      )) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { instance: "/v1/problems/01ARZ3NDEKTSV4RRFFQ69G5FB5" },
    });
  });

  it("decodes application/problem+json responses", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          title: "Conflict",
          status: 409,
          code: "version_conflict",
          requestId: "req_body",
        }),
        { status: 409, headers: { "content-type": "application/problem+json" } },
      )) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 409, code: "version_conflict", requestId: "req_body" },
    });
  });

  it("matches response media types case-insensitively", async () => {
    const responses = [
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "Application/JSON; Charset=UTF-8" },
      }),
      new Response(JSON.stringify({ title: "Conflict", code: "case_test" }), {
        status: 409,
        headers: { "content-type": "Application/Problem+JSON" },
      }),
    ];
    const fetchImpl = (async () => responses.shift()!) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/health" })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 409, code: "case_test" },
    });
  });

  it("uses the HTTP status when problem details report a conflicting status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ title: "Stale status", status: 401 }), {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 500 },
    });
  });

  it("preserves HTTP status for empty or malformed JSON error bodies", async () => {
    const responses = [
      new Response("", {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      }),
      new Response("{not-json", {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      }),
    ];
    const fetchImpl = (async () => responses.shift()!) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 401 },
    });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      problem: { status: 403, detail: "{not-json" },
    });
  });

  it("provides a non-empty title for empty status text", async () => {
    const fetchImpl = (async () =>
      new Response("", {
        status: 500,
        statusText: "",
        headers: { "content-type": "application/problem+json" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toMatchObject({
      message: "Platform API request failed",
      problem: { title: "Platform API request failed", status: 500 },
    });
  });

  it("wraps network failures as transport errors", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    expect(sdk.request({ method: "GET", path: "/v1/health" })).rejects.toBeInstanceOf(
      PlatformTransportError,
    );
  });
});
