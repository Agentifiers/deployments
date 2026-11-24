import { IdentityError } from "@deployments-ai/identity";
import type { AccountCaller } from "./account-authentication.ts";
import type { IdentityApplication } from "./application.ts";
import { empty, json, type RestApiResponse } from "./http-responses.ts";

function text(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value) {
    throw new IdentityError("invalid_request", `${name} is required.`, { exposeDescription: true });
  }
  return value;
}

function optionalText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  return typeof value === "string" && value ? { [name]: value } : {};
}

/**
 * The console's account-lifecycle routes under `/v1/account/`: the profile, email change, and
 * deletion. They authenticate like every other account route; returns `undefined` for other paths.
 */
export async function accountLifecycleResponse(
  application: Pick<IdentityApplication, "account">,
  caller: AccountCaller,
  request: {
    readonly method: string;
    readonly path: string;
    readonly readBody: () => Record<string, unknown>;
  },
): Promise<RestApiResponse | undefined> {
  const principalId = caller.principal.id;
  switch (`${request.method} ${request.path}`) {
    case "GET /v1/account/profile":
      return json(200, await application.account.profile(principalId));
    case "POST /v1/account/email-change": {
      const body = request.readBody();
      return json(
        200,
        await application.account.requestEmailChange({
          ...optionalText(body, "code"),
          newEmail: text(body, "newEmail"),
          password: text(body, "password"),
          principalId,
        }),
      );
    }
    case "DELETE /v1/account/email-change":
      await application.account.cancelEmailChange(principalId);
      return empty(204);
    case "POST /v1/account/delete": {
      const body = request.readBody();
      await application.account.deleteAccount({
        ...optionalText(body, "code"),
        password: text(body, "password"),
        principalId,
      });
      return empty(204);
    }
    default:
      return undefined;
  }
}

/**
 * The two links sent by email. They need no session: the token in the body names the change and
 * proves the reader holds that mailbox, so the page can open in any browser.
 */
export async function emailChangeLinkResponse(
  application: Pick<IdentityApplication, "account">,
  request: {
    readonly method: string;
    readonly path: string;
    readonly readBody: () => Record<string, unknown>;
  },
): Promise<RestApiResponse | undefined> {
  if (request.method !== "POST") return undefined;
  switch (request.path) {
    case "/v1/auth/email-change/confirm":
      return json(
        200,
        await application.account.confirmEmailChange({ token: text(request.readBody(), "token") }),
      );
    case "/v1/auth/email-change/report":
      return json(
        200,
        await application.account.reportEmailChange({ token: text(request.readBody(), "token") }),
      );
    default:
      return undefined;
  }
}
