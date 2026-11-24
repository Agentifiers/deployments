import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { createHttpApiV2Handler, type HttpApiV2Event, type HttpApiV2Result } from "./lambda.ts";

const E2E_CALLBACK_SECRET_ARN_ENV = "DEPLOYMENTS_AI_E2E_CALLBACK_SECRET_ARN";
const E2E_CALLBACK_ECHO_PREFIX = "E2E callback echo: ";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MARKER_CHARACTERS = 256;

export interface E2eCallbackCredentials {
  readonly initial: string;
  readonly rotated: string;
}

interface CallbackInvocation {
  readonly idempotencyKey: string;
  readonly marker: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

function credentialName(pathname: string): keyof E2eCallbackCredentials | undefined {
  if (pathname === "/_e2e/callback/initial") return "initial";
  if (pathname === "/_e2e/callback/rotated") return "rotated";
  return undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validates the envelope sent by the worker's `runtimeHttpCallbackRequestBody`. */
function callbackInvocation(value: unknown): CallbackInvocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Readonly<Record<string, unknown>>;
  const input = body.input;
  if (
    body.version !== 1 ||
    !nonEmptyString(body.toolName) ||
    !nonEmptyString(body.toolCallId) ||
    !nonEmptyString(body.idempotencyKey) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return undefined;
  }
  const marker = (input as Readonly<Record<string, unknown>>).marker;
  if (!nonEmptyString(marker) || marker.length > MAX_MARKER_CHARACTERS) return undefined;
  return {
    idempotencyKey: body.idempotencyKey,
    marker,
    toolCallId: body.toolCallId,
    toolName: body.toolName,
  };
}

export function createE2eCallbackFetch(loadCredentials: () => Promise<E2eCallbackCredentials>) {
  return async (request: Request): Promise<Response> => {
    const selected = credentialName(new URL(request.url).pathname);
    if (!selected) return new Response(null, { status: 404 });
    const credentials = await loadCredentials();
    if (request.headers.get("authorization") !== `Bearer ${credentials[selected]}`) {
      return Response.json(
        { error: "unauthorized" },
        { headers: { "www-authenticate": "Bearer" }, status: 401 },
      );
    }
    if (request.method !== "POST") {
      return new Response(null, { headers: { allow: "POST" }, status: 405 });
    }

    let parsed: unknown;
    try {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      const body = await request.text();
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      parsed = JSON.parse(body);
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const invocation = callbackInvocation(parsed);
    if (!invocation) {
      return Response.json(
        {
          error: "invalid_callback",
          message:
            "Expected a version 1 callback envelope with toolName, toolCallId, idempotencyKey, and a bounded string input.marker.",
        },
        { status: 400 },
      );
    }
    // `authenticatedAs` avoids secret-shaped keys (credential/token/key) that runtime redaction masks.
    return Response.json({
      authenticatedAs: selected,
      echo: `${E2E_CALLBACK_ECHO_PREFIX}${invocation.marker}`,
      idempotencyKey: invocation.idempotencyKey,
      marker: invocation.marker,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
    });
  };
}

async function loadCredentials(): Promise<E2eCallbackCredentials> {
  const secretArn = process.env[E2E_CALLBACK_SECRET_ARN_ENV]?.trim();
  if (!secretArn) throw new Error(`${E2E_CALLBACK_SECRET_ARN_ENV} is required.`);
  const parsed = JSON.parse(
    await loadAwsSecretString(secretArn),
  ) as Partial<E2eCallbackCredentials>;
  if (!parsed.initial?.trim() || !parsed.rotated?.trim() || parsed.initial === parsed.rotated) {
    throw new Error("E2E callback secret must contain distinct initial and rotated secrets.");
  }
  return { initial: parsed.initial, rotated: parsed.rotated };
}

const fetchHandler = createE2eCallbackFetch(loadCredentials);
const lambdaHandler = createHttpApiV2Handler(fetchHandler);

export function handler(event: HttpApiV2Event): Promise<HttpApiV2Result> {
  return lambdaHandler(event);
}
