import { describe, expect, mock, test } from "bun:test";
import { IdentityError } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import { makeIdentityHttpHandler } from "./http.ts";

const config = {
  applicationOrigin: "https://app.deployments.ai",
  issuer: "https://auth.deployments.ai",
  publicResponseMinimumMs: 30,
  queuePublicEmailRequest: async () => undefined,
  registrationEnabled: true,
  secureCookies: true,
  uiOrigin: "https://auth.deployments.ai",
};

const publicRequest = {
  headers: {
    "content-type": "application/json",
    cookie: "__Host-dpl_csrf=csrf-token",
    origin: config.uiOrigin,
    "x-csrf-token": "csrf-token",
  },
  httpMethod: "POST",
} as const;

describe("durable public identity email responses", () => {
  test("accepts sign-up on schedule after its durable queue handoff", async () => {
    const queuePublicEmailRequest = mock(async () => undefined);
    const handler = makeIdentityHttpHandler({} as IdentityApplication, {
      ...config,
      queuePublicEmailRequest,
    });
    const started = performance.now();

    const response = await handler({
      ...publicRequest,
      body: JSON.stringify({ email: "new-user@example.com" }),
      path: "/v1/auth/sign-up",
    });

    expect(response.statusCode).toBe(202);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
    expect(queuePublicEmailRequest).toHaveBeenCalledWith({
      email: "new-user@example.com",
      operation: "sign-up",
    });
  });

  test("accepts password recovery on schedule after its durable queue handoff", async () => {
    const queuePublicEmailRequest = mock(async () => undefined);
    const handler = makeIdentityHttpHandler({} as IdentityApplication, {
      ...config,
      queuePublicEmailRequest,
    });
    const started = performance.now();

    const response = await handler({
      ...publicRequest,
      body: JSON.stringify({ email: "existing-user@example.com" }),
      path: "/v1/auth/password/forgot",
    });

    expect(response.statusCode).toBe(202);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
    expect(queuePublicEmailRequest).toHaveBeenCalledWith({
      email: "existing-user@example.com",
      operation: "password-recovery",
    });
  });

  test("keeps the Lambda invocation alive until the queue accepts the request", async () => {
    let acceptQueueRequest: (() => void) | undefined;
    const queuePublicEmailRequest = mock(
      () =>
        new Promise<void>((resolve) => {
          acceptQueueRequest = resolve;
        }),
    );
    const handler = makeIdentityHttpHandler({} as IdentityApplication, {
      ...config,
      queuePublicEmailRequest,
    });
    let settled = false;
    const response = handler({
      ...publicRequest,
      body: JSON.stringify({ email: "new-user@example.com" }),
      path: "/v1/auth/sign-up",
    });
    void response.then(() => {
      settled = true;
    });

    await Bun.sleep(50);
    expect(settled).toBeFalse();
    acceptQueueRequest?.();
    expect((await response).statusCode).toBe(202);
  });

  test("preserves a fast public rate-limit error while retaining the response floor", async () => {
    const queuePublicEmailRequest = mock(async () => {
      throw new IdentityError("slow_down", "Too many requests.", { status: 429 });
    });
    const handler = makeIdentityHttpHandler({} as IdentityApplication, {
      ...config,
      queuePublicEmailRequest,
    });
    const started = performance.now();

    const response = await handler({
      ...publicRequest,
      body: JSON.stringify({ email: "limited-user@example.com" }),
      path: "/v1/auth/sign-up",
    });

    expect(response.statusCode).toBe(429);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("returns a generic retryable failure when the durable handoff fails", async () => {
    const queuePublicEmailRequest = mock(async () => {
      throw new Error("SQS unavailable");
    });
    const handler = makeIdentityHttpHandler({} as IdentityApplication, {
      ...config,
      queuePublicEmailRequest,
    });

    const response = await handler({
      ...publicRequest,
      body: JSON.stringify({ email: "retry@example.com" }),
      path: "/v1/auth/sign-up",
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "temporarily_unavailable" });
  });
});
