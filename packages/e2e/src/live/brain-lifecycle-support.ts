import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpRequestError, type E2eConfigurationError } from "../harness/errors.ts";
import {
  type E2eHttpClientService,
  fetchResendingGatewayThrottles,
  type HttpResult,
} from "../harness/http-client.ts";
import { record, retryUnavailableHttpRequest, stringField } from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import type { ScopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";

type JsonRecord = Record<string, unknown>;
type BrainApiError = E2eConfigurationError | HttpRequestError | Error;

interface BrainApiRequest {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly method: string;
  readonly path: string;
}

export interface BrainApi {
  readonly request: (request: BrainApiRequest) => Effect.Effect<HttpResult, BrainApiError>;
  readonly upload: (input: {
    readonly bytes: Uint8Array;
    readonly idempotencyKey: string;
    readonly mediaType: string;
    readonly path: string;
  }) => Effect.Effect<HttpResult, BrainApiError>;
}

export function problemCode(response: HttpResult, status: number, label: string): string {
  return stringField(json(response, status, label), "code", label);
}

/**
 * Tenant-JWT Brain API client for the credentialed suite. Every request carries
 * the organization, project, and environment headers the query routes require,
 * reads the current (auto-refreshed) platform token, and retries transient 503s.
 */
export function makeBrainApi(config: ScopedE2eConfig, http: E2eHttpClientService): BrainApi {
  const headers = (idempotencyKey?: string) => ({
    ...tenantHeaders(config.platformCredential, config),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  });
  return {
    request: (request) =>
      retryUnavailableHttpRequest(
        `${request.method} ${request.path}`,
        // Suspend so every poll and retry reads the current token instead of the one
        // captured when the request effect was built.
        Effect.suspend(() =>
          http.request({
            ...(request.body === undefined ? {} : { body: request.body }),
            headers: headers(request.idempotencyKey),
            method: request.method,
            path: request.path,
            timeoutMs: 60_000,
          }),
        ),
      ),
    upload: (input) =>
      retryUnavailableHttpRequest(
        `PUT ${input.path}`,
        Effect.tryPromise({
          try: async () => {
            const response = await fetchResendingGatewayThrottles(
              new URL(input.path, config.apiUrl),
              {
                body: input.bytes,
                headers: {
                  ...headers(input.idempotencyKey),
                  "content-length": String(input.bytes.byteLength),
                  "content-type": input.mediaType,
                },
                method: "PUT",
                signal: AbortSignal.timeout(60_000),
              },
            );
            const body = await response.text();
            let parsed: unknown;
            try {
              parsed = body.trim() ? (JSON.parse(body) as unknown) : undefined;
            } catch {
              parsed = undefined;
            }
            return {
              body,
              headers: Object.fromEntries(response.headers.entries()),
              json: parsed,
              status: response.status,
            };
          },
          catch: (cause) =>
            new HttpRequestError({
              cause,
              message: `PUT ${input.path} failed before receiving a response.`,
            }),
        }),
      ),
  };
}

/** Sends one JSON-RPC message to the hosted Brain MCP endpoint. */
export function brainMcp(
  api: BrainApi,
  id: string,
  method: string,
  params?: Readonly<Record<string, unknown>>,
) {
  return api
    .request({
      body: { id, jsonrpc: "2.0", method, ...(params ? { params } : {}) },
      method: "POST",
      path: "/v1/mcp/brain",
    })
    .pipe(
      Effect.map((response) => {
        const message = json(response, 200, `Brain MCP ${method}`);
        expect(message, `Brain MCP ${method}: ${response.body}`).not.toHaveProperty("error");
        expect(message.id).toBe(id);
        return { headers: response.headers, result: record(message.result, `MCP ${method}`) };
      }),
    );
}

/** Returns the decoded JSON payload and error flag from a Brain MCP tool result. */
export function brainToolOutput(result: JsonRecord, label: string) {
  const [content] = records(result.content, `${label}.content`);
  const text = stringField(content ?? {}, "text", `${label}.content[0]`);
  let payload: unknown = text;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = text;
  }
  return { isError: result.isError === true, payload, text };
}
