import { ExitCode } from "@agentifiers/deployments-cli/exit-codes";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  cleanupHttpRequest,
  cleanupHttpResult,
  cleanupMemoryHttpRequests,
  liveAgentServiceAccountScopes,
  redactionSafeRandomId,
  retryUnavailableCliRequest,
  retryUnavailableHttpRequest,
} from "../harness/live-agent.ts";

describe("live agent cleanup", () => {
  it("generates random fixture ids that cannot be mistaken for phone numbers", () => {
    const problematicUuid = "f72c9bbd-8d9d-4767-80cd-a6122088493a";

    expect(problematicUuid).toContain("6122088493");
    expect(redactionSafeRandomId(problematicUuid)).toMatch(/^[a-p-]+$/u);
  });

  it("adds feature-specific scopes to the generated environment credential", () => {
    const scopes = liveAgentServiceAccountScopes(["agent-email:admin", "agents:read"]).split(",");
    expect(scopes).toContain("agent-email:admin");
    expect(scopes.filter((scope) => scope === "agents:read")).toHaveLength(1);
    expect(
      scopes.filter((scope) => !(PLATFORM_CLI_SCOPES as readonly string[]).includes(scope)),
    ).toEqual([]);
  });

  it("accepts successful or already-absent cleanup and rejects server failures", async () => {
    await expect(
      Effect.runPromise(
        cleanupHttpResult("resource", { body: "", headers: {}, json: undefined, status: 204 }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        cleanupHttpResult("resource", { body: "", headers: {}, json: undefined, status: 404 }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        cleanupHttpResult("resource", {
          body: "upstream failed",
          headers: {},
          json: undefined,
          status: 500,
        }),
      ),
    ).rejects.toThrow("resource cleanup returned HTTP 500: upstream failed");
  });

  it("retries rollout-time service unavailability before completing cleanup", async () => {
    let attempts = 0;
    await expect(
      Effect.runPromise(
        cleanupHttpRequest(
          "resource",
          Effect.sync(() => {
            attempts += 1;
            return {
              body: "",
              headers: {},
              json: undefined,
              status: attempts === 1 ? 503 : 204,
            };
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("retries unavailable idempotent mutations but returns other failures immediately", async () => {
    let attempts = 0;
    const recovered = await Effect.runPromise(
      retryUnavailableHttpRequest(
        "mutation",
        Effect.sync(() => {
          attempts += 1;
          return {
            body: "",
            headers: {},
            json: undefined,
            status: attempts === 1 ? 503 : 202,
          };
        }),
      ),
    );
    expect(recovered.status).toBe(202);
    expect(attempts).toBe(2);

    const failed = await Effect.runPromise(
      retryUnavailableHttpRequest(
        "mutation",
        Effect.sync(() => {
          attempts += 1;
          return { body: "", headers: {}, json: undefined, status: 500 };
        }),
      ),
    );
    expect(failed.status).toBe(500);
    expect(attempts).toBe(3);
  });

  it("retries unavailable idempotent CLI cleanup operations", async () => {
    let attempts = 0;
    const recovered = await Effect.runPromise(
      retryUnavailableCliRequest(
        "CLI cleanup",
        Effect.sync(() => {
          attempts += 1;
          return {
            exitCode: attempts === 1 ? ExitCode.unavailable : ExitCode.success,
            signal: null,
            stderr: attempts === 1 ? "Error: Unable to reach the Deployments.ai API." : "",
            stdout: attempts === 1 ? "" : '{"status":"stopped"}',
          };
        }),
      ),
    );
    expect(recovered.exitCode).toBe(0);
    expect(attempts).toBe(2);

    const denied = await Effect.runPromise(
      retryUnavailableCliRequest(
        "CLI cleanup",
        Effect.sync(() => {
          attempts += 1;
          return { exitCode: 1, signal: null, stderr: "Forbidden", stdout: "" };
        }),
      ),
    );
    expect(denied.stderr).toBe("Forbidden");
    expect(attempts).toBe(3);
  });

  it("archives memory before permanent cleanup and only tolerates known lifecycle replays", async () => {
    let deletes = 0;
    await expect(
      Effect.runPromise(
        cleanupMemoryHttpRequests(
          "memory",
          Effect.succeed({ body: "", headers: {}, json: undefined, status: 200 }),
          Effect.sync(() => {
            deletes += 1;
            return { body: "", headers: {}, json: undefined, status: 200 };
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(deletes).toBe(1);

    await expect(
      Effect.runPromise(
        cleanupMemoryHttpRequests(
          "memory",
          Effect.succeed({
            body: '{"code":"invalid_lifecycle"}',
            headers: {},
            json: { code: "invalid_lifecycle" },
            status: 409,
          }),
          Effect.succeed({ body: "", headers: {}, json: undefined, status: 200 }),
        ),
      ),
    ).resolves.toBeUndefined();

    await expect(
      Effect.runPromise(
        cleanupMemoryHttpRequests(
          "memory",
          Effect.succeed({
            body: '{"code":"memory_space_archived"}',
            headers: {},
            json: { code: "memory_space_archived" },
            status: 409,
          }),
          Effect.succeed({ body: "", headers: {}, json: undefined, status: 200 }),
        ),
      ),
    ).rejects.toThrow("memory archive cleanup returned HTTP 409");
  });
});
