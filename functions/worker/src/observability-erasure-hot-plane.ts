import type { ConversationErasureScope } from "./observability-erasure-contract.ts";

export type HotPlaneErasureResult =
  | { readonly rowsDeleted: number; readonly status: "complete"; readonly verifiedAt: string }
  | {
      readonly reason: "mutation_running";
      readonly remainingRows: number;
      readonly status: "pending";
    }
  | { readonly reason: "writer_catching_up"; readonly status: "pending" };

export interface HotPlaneErasureClient {
  readonly erase: (input: {
    /** Canonical deletion time; the hot-plane writer must have consumed facts past it. */
    readonly drainAnchorAt: string;
    readonly operationId: string;
    readonly organizationId: string;
    readonly scope?: ConversationErasureScope | undefined;
    readonly timeoutMs: number;
  }) => Promise<HotPlaneErasureResult>;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactly(body: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}

async function jsonObject(response: Response) {
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Hot-plane organization erasure returned a non-object body.");
  }
  return body as Readonly<Record<string, unknown>>;
}

function decodePending(body: Readonly<Record<string, unknown>>): HotPlaneErasureResult {
  if (
    body.status === "pending" &&
    body.reason === "writer_catching_up" &&
    hasExactly(body, ["reason", "status"])
  ) {
    return { reason: "writer_catching_up", status: "pending" };
  }
  if (
    body.status === "pending" &&
    body.reason === "mutation_running" &&
    nonNegativeInteger(body.remainingRows) &&
    hasExactly(body, ["reason", "remainingRows", "status"])
  ) {
    return { reason: "mutation_running", remainingRows: body.remainingRows, status: "pending" };
  }
  throw new Error("Hot-plane organization erasure returned an invalid pending state.");
}

async function problemCode(response: Response) {
  try {
    const body = (await response.json()) as { readonly code?: unknown };
    return typeof body.code === "string" ? body.code : "unknown";
  } catch {
    return "unknown";
  }
}

/** Client for `POST /internal/organization-erasures` on the private hot plane. */
export function makeHotPlaneErasureClient(input: {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly serviceToken: () => Promise<string>;
}): HotPlaneErasureClient {
  const send = input.fetch ?? fetch;
  const url = new URL("/internal/organization-erasures", input.baseUrl).toString();
  return {
    async erase({ drainAnchorAt, operationId, organizationId, scope, timeoutMs }) {
      const response = await send(url, {
        body: JSON.stringify({ drainAnchorAt, operationId, organizationId, scope }),
        headers: {
          authorization: `Bearer ${await input.serviceToken()}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 200) {
        const body = await jsonObject(response);
        const verifiedAt = typeof body.verifiedAt === "string" ? Date.parse(body.verifiedAt) : NaN;
        if (body.status !== "complete" || !nonNegativeInteger(body.rowsDeleted)) {
          throw new Error("Hot-plane organization erasure returned an invalid completion.");
        }
        if (!Number.isFinite(verifiedAt)) {
          throw new Error("Hot-plane organization erasure returned no verification time.");
        }
        return {
          rowsDeleted: body.rowsDeleted,
          status: "complete",
          verifiedAt: new Date(verifiedAt).toISOString(),
        };
      }
      if (response.status === 202) return decodePending(await jsonObject(response));
      // The hot plane answers 503 while its writer replays after a restart.
      if (response.status === 503) return { reason: "writer_catching_up", status: "pending" };
      throw new Error(
        `Hot-plane organization erasure failed with HTTP ${response.status} (${await problemCode(response)}).`,
      );
    },
  };
}
