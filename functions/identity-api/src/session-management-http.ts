import { IdentityError } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import { empty, json, type RestApiResponse } from "./http-responses.ts";

const SESSIONS_PATH = "/v1/auth/sessions";
const SESSION_PATH = /^\/v1\/auth\/sessions\/([^/]+)$/u;

export interface SessionManagementRequest {
  /** `Set-Cookie` value that expires the identity browser session cookie. */
  readonly clearSessionCookie: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Raw identity browser session cookie value, or an empty string when absent. */
  readonly rawSession: string;
}

/**
 * Serves `GET /v1/auth/sessions` and `DELETE /v1/auth/sessions/{sessionId}`. The caller must
 * already have applied the Origin + CSRF mutation guard to `DELETE`. Returns `undefined` for
 * every other route.
 */
export async function sessionManagementResponse(
  application: Pick<IdentityApplication, "listSessions" | "revokeSession">,
  request: SessionManagementRequest,
): Promise<RestApiResponse | undefined> {
  if (request.method === "GET" && request.path === SESSIONS_PATH) {
    const rawLimit = request.query.limit;
    if (rawLimit !== undefined && !/^\d{1,3}$/u.test(rawLimit)) {
      throw new IdentityError("invalid_request", "Session page limit is invalid.", {
        exposeDescription: true,
      });
    }
    const page = await application.listSessions(request.rawSession, {
      ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
      ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
    });
    return page ? json(200, page) : json(401, { error: "unauthorized" });
  }
  const sessionId = request.method === "DELETE" ? SESSION_PATH.exec(request.path)?.[1] : undefined;
  if (sessionId === undefined) return undefined;
  const revoked = await application.revokeSession(request.rawSession, sessionId);
  if (!revoked) return json(401, { error: "unauthorized" });
  if (revoked.outcome === "not_found") return json(404, { error: "not_found" });
  return revoked.current
    ? { ...empty(204), multiValueHeaders: { "Set-Cookie": [request.clearSessionCookie] } }
    : empty(204);
}
