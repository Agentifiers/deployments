import { Effect } from "effect";
import { ulid } from "ulid";
import type { HttpRequest, HttpResult } from "./http-client.ts";
import { record } from "./live-agent.ts";

function parseJson(body: string) {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Sends one request to an origin other than the platform API without following redirects. */
export function remoteRequest(baseUrl: string, request: HttpRequest) {
  return Effect.tryPromise({
    try: async (): Promise<HttpResult> => {
      const response = await fetch(new URL(request.path, baseUrl), {
        ...(request.body === undefined
          ? {}
          : {
              body: typeof request.body === "string" ? request.body : JSON.stringify(request.body),
            }),
        headers: {
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          ...request.headers,
        },
        method: request.method,
        redirect: "error",
        signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      });
      const body = await response.text();
      return {
        body,
        headers: Object.fromEntries(response.headers.entries()),
        json: parseJson(body),
        status: response.status,
      };
    },
    catch: (cause) => new Error(`${request.method} ${request.path} failed.`, { cause }),
  });
}

/**
 * Stores a channel-runtime credential for one binding through the JWT credential API and revokes
 * that exact generation when the enclosing scope closes.
 */
export function acquireChannelBindingCredential(input: {
  readonly bindingId: string;
  readonly channelApiUrl: string;
  readonly environmentId: string;
  readonly label: string;
  readonly platformAuth: Readonly<Record<string, string>>;
  readonly scopes?: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}) {
  const credentialId = ulid();
  const path = `/v1/environments/${input.environmentId}/credentials/${credentialId}`;
  return Effect.acquireRelease(
    remoteRequest(input.channelApiUrl, {
      body: {
        ownerId: input.bindingId,
        ownerType: "channel-binding",
        purpose: "channel-runtime",
        ...(input.scopes ? { scopes: input.scopes } : {}),
        values: input.values,
      },
      headers: input.platformAuth,
      method: "POST",
      path,
    }).pipe(
      Effect.map((response) => {
        if (response.status !== 201) {
          throw new Error(
            `${input.label} credential create returned HTTP ${String(response.status)}: ${response.body}`,
          );
        }
        return record(response.json, `${input.label} credential`);
      }),
    ),
    (created) => {
      const generation = record(
        created.reference,
        `${input.label} credential reference`,
      ).generation;
      if (!Number.isSafeInteger(generation)) {
        return Effect.die(new Error(`${input.label} credential generation was invalid.`));
      }
      const query = new URLSearchParams({
        generation: String(generation),
        ownerId: input.bindingId,
        ownerType: "channel-binding",
      });
      return remoteRequest(input.channelApiUrl, {
        headers: input.platformAuth,
        method: "DELETE",
        path: `${path}?${query.toString()}`,
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 204 || response.status === 404
            ? Effect.void
            : Effect.die(
                new Error(
                  `${input.label} credential cleanup returned HTTP ${String(response.status)}.`,
                ),
              ),
        ),
        Effect.orDie,
      );
    },
  );
}
