import { IdentityError } from "@deployments-ai/identity";
import type { AccountAuthenticator } from "./account-authentication.ts";
import { DeviceCodeRefusedError, type DeviceApplication } from "./device-application.ts";
import { empty, json, type RestApiResponse } from "./http-responses.ts";

const DEVICE_PATH = /^\/v1\/account\/device\/(claim|approve|deny)$/u;

export interface AccountDeviceRequest {
  readonly authorization: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly readBody: () => Record<string, unknown>;
}

/**
 * The console's device approval page, under `/v1/account/device/`. Like the other account routes,
 * these take the console's bearer access token, so they skip the browser Origin and CSRF guard.
 * The grant binds to the identity browser session behind that token. A code that cannot be used
 * answers `400` with `device_code_expired`, `device_code_used`, or `device_code_unknown`, so the
 * page can say which. Returns `undefined` for every other request.
 */
export async function accountDeviceResponse(
  device: DeviceApplication,
  authenticate: AccountAuthenticator,
  request: AccountDeviceRequest,
): Promise<RestApiResponse | undefined> {
  const action = request.method === "POST" ? DEVICE_PATH.exec(request.path)?.[1] : undefined;
  if (action === undefined) return undefined;
  const caller = await authenticate(request.authorization);
  if (!caller) return json(401, { error: "unauthorized" });
  const userCode = request.readBody().userCode;
  if (typeof userCode !== "string" || !userCode) {
    throw new IdentityError("invalid_request", "userCode is required.", {
      exposeDescription: true,
    });
  }
  const approver = { principalId: caller.principal.id, sessionId: caller.sessionId };
  try {
    if (action === "claim") return json(200, await device.claim(userCode, approver));
    await device.decide(userCode, approver, action === "approve" ? "approved" : "denied");
    return empty(204);
  } catch (error) {
    if (error instanceof DeviceCodeRefusedError) {
      return json(400, { error: `device_code_${error.refusal}` });
    }
    throw error;
  }
}
