import {
  DirectoryContentionError,
  type Directory,
  type DirectoryCaller,
  type DirectoryResult,
  type DirectoryUser,
} from "@deployments-ai/db";
import type {
  ApiActivity,
  GateDecision,
  OrganizationGate,
} from "@deployments-ai/organization-admission";
import { errorLogFields } from "../error-log-fields.ts";
import { discoveryDocument } from "./scim-discovery.ts";
import { invalidSyntax, REFUSAL_ERRORS, ScimError } from "./scim-error.ts";
import { parseScimRequest, type ScimCommand } from "./scim-request.ts";
import { listResponse, renderUser, scimErrorResponse, scimResponse } from "./scim-response.ts";

const SCIM_PATH_PREFIX = "/scim/v2/";
const SCIM_BODY_BYTE_LIMIT = 64 * 1024;
const BODY_METHODS: ReadonlySet<string> = new Set(["PATCH", "POST", "PUT"]);
const BODY_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/scim+json",
]);

const UNAUTHORIZED = new ScimError({
  detail: "A valid directory bearer token is required.",
  headers: { "www-authenticate": 'Bearer realm="scim"' },
  status: 401,
});
const UNSUPPORTED_MEDIA_TYPE = new ScimError({
  detail: "Send the body as application/scim+json or application/json.",
  status: 415,
});
const TOO_LARGE = new ScimError({
  detail: `The request body exceeds ${SCIM_BODY_BYTE_LIMIT} bytes.`,
  status: 413,
});
const CONTENDED = new ScimError({
  detail: "The user kept changing concurrently; retry the request.",
  headers: { "retry-after": "1" },
  status: 503,
});
const FAILED = new ScimError({ detail: "The SCIM request failed.", status: 500 });

function bearerToken(request: Request) {
  return /^Bearer\s+(\S+)\s*$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
}

async function readJsonBody(request: Request): Promise<{ readonly json: unknown } | ScimError> {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!mediaType || !BODY_MEDIA_TYPES.has(mediaType)) return UNSUPPORTED_MEDIA_TYPE;
  if (Number(request.headers.get("content-length")) > SCIM_BODY_BYTE_LIMIT) return TOO_LARGE;
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > SCIM_BODY_BYTE_LIMIT) return TOO_LARGE;
  try {
    return { json: JSON.parse(text) };
  } catch {
    return invalidSyntax("The request body is not valid JSON.");
  }
}

function userResponse(result: DirectoryResult<DirectoryUser>, baseUrl: string, status: 200 | 201) {
  if (result.kind === "refused") return scimErrorResponse(REFUSAL_ERRORS[result.reason]);
  const user = renderUser(result.value, baseUrl);
  return scimResponse(status, user, status === 201 ? { location: user.meta.location } : {});
}

/** Deprovisioning reduces access, so a suspended organization's directory may still do it. */
function scimActivity(command: ScimCommand): ApiActivity {
  switch (command.kind) {
    case "change":
      return command.change.active === false ? "api.remediate" : "api.write";
    case "create":
      return "api.write";
    case "delete":
      return "api.remediate";
    case "discovery":
    case "get":
    case "list":
      return "api.read";
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

function refusalError(refusal: Exclude<GateDecision, { readonly kind: "admitted" }>) {
  switch (refusal.kind) {
    case "limited":
      return new ScimError({
        detail: `This organization is limited to ${refusal.ratePerSecond} requests per second with a burst of ${refusal.burst}.`,
        headers: { "retry-after": String(refusal.retryAfterSeconds) },
        status: 429,
      });
    case "suspended":
      return new ScimError({
        detail: [
          "The organization is suspended: until every hold is released, the directory can read and deprovision users but not create or change them.",
          ...refusal.holds.map((hold) => hold.customerMessage),
        ].join(" "),
        status: 403,
      });
    default: {
      const unhandled: never = refusal;
      return unhandled;
    }
  }
}

async function execute(
  users: Directory["users"],
  caller: DirectoryCaller,
  command: ScimCommand,
  baseUrl: string,
): Promise<Response> {
  switch (command.kind) {
    case "change":
      return userResponse(await users.change(caller, command.id, command.change), baseUrl, 200);
    case "create":
      return userResponse(await users.create(caller, command.user), baseUrl, 201);
    case "delete": {
      const result = await users.delete(caller, command.id);
      return result.kind === "refused"
        ? scimErrorResponse(REFUSAL_ERRORS[result.reason])
        : new Response(null, { status: 204 });
    }
    case "discovery":
      return scimResponse(200, discoveryDocument(command.document, baseUrl));
    case "get":
      return userResponse(await users.get(caller, command.id), baseUrl, 200);
    case "list": {
      const page = await users.list(caller, command.query);
      const resources = page.items.map((user) => renderUser(user, baseUrl));
      return scimResponse(200, listResponse(resources, page));
    }
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

/**
 * `/scim/v2/*` for an organization's directory. The organization comes only from the bearer
 * token, which is checked before the body is read; the organization's standing and request rate
 * are decided as on `/v1`, once the request has parsed into a command.
 */
export function createScimApi(dependencies: {
  readonly directory: Pick<Directory, "authenticate" | "users">;
  readonly gate: OrganizationGate;
}) {
  const { directory, gate } = dependencies;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(SCIM_PATH_PREFIX)) return undefined;
    try {
      const token = bearerToken(request);
      const caller = token === undefined ? undefined : await directory.authenticate(token);
      if (!caller) return scimErrorResponse(UNAUTHORIZED);
      const body = BODY_METHODS.has(request.method) ? await readJsonBody(request) : undefined;
      if (body instanceof ScimError) return scimErrorResponse(body);
      const command = parseScimRequest({
        body: body?.json,
        method: request.method,
        query: url.searchParams,
        segments: url.pathname
          .slice(SCIM_PATH_PREFIX.length)
          .split("/")
          .filter((segment) => segment !== ""),
      });
      if (command instanceof ScimError) return scimErrorResponse(command);
      const decision = await gate.admit(caller.organizationId, scimActivity(command));
      if (decision.kind !== "admitted") return scimErrorResponse(refusalError(decision));
      return await execute(directory.users, caller, command, `${url.origin}/scim/v2`);
    } catch (cause) {
      if (cause instanceof DirectoryContentionError) return scimErrorResponse(CONTENDED);
      console.error("SCIM request failed.", { ...errorLogFields(cause), method: request.method });
      return scimErrorResponse(FAILED);
    }
  };
}
