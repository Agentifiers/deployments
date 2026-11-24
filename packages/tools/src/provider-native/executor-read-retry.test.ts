import { expect, test } from "bun:test";
import {
  executeProviderNativeHttpTool,
  ProviderNativeExecutionRetryableError,
} from "./executor.ts";
import { providerNativeHttpToolDefinitions } from "./registry.ts";

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 as const }];

test("keeps exhausted provider read retries retryable for the worker", async () => {
  const base = providerNativeHttpToolDefinitions.find(
    (entry) => entry.toolName === "sendgrid.stats.read",
  );
  if (!base) throw new Error("Missing test definition sendgrid.stats.read.");

  expect(
    executeProviderNativeHttpTool(
      {
        credential: {
          externalAccountId: "sendgrid-account-1",
          fields: { apiKey: "sendgrid-secret-token-123456" },
          provider: "sendgrid",
        },
        definition: {
          ...base,
          retryPolicy: {
            baseDelayMs: 10,
            maxAttempts: 2,
            maxDelayMs: 100,
            retryableStatusCodes: [503],
          },
        },
        input: {},
        request: {
          idempotencyKey: "run-1:sendgrid-exhausted-read",
          toolName: "sendgrid.stats.read",
        },
      },
      {
        dnsLookup: PUBLIC_DNS,
        pinnedRequest: async () => new Response("temporarily unavailable", { status: 503 }),
        sleep: async () => {},
      },
    ),
  ).rejects.toBeInstanceOf(ProviderNativeExecutionRetryableError);
});
