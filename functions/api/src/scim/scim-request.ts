import {
  Ulid,
  type DirectoryUserAttribute,
  type DirectoryUserChange,
  type DirectoryUserQuery,
  type NewDirectoryUser,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import {
  chosenEmail,
  directoryText,
  displayNameOf,
  emailValue,
  jsonObject,
  scimBoolean,
} from "./scim-attributes.ts";
import { invalidSyntax, invalidValue, REFUSAL_ERRORS, ScimError } from "./scim-error.ts";
import { parsePatch } from "./scim-patch.ts";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_MAX_COUNT = 100;

export type ScimDiscovery =
  | "resource-types"
  | "schemas"
  | "service-provider-config"
  | "user-resource-type"
  | "user-schema";

/** A SCIM request as the directory understands it. Nothing past the parse reads SCIM JSON. */
export type ScimCommand =
  | { readonly change: DirectoryUserChange; readonly id: Ulid; readonly kind: "change" }
  | { readonly id: Ulid; readonly kind: "delete" }
  | { readonly document: ScimDiscovery; readonly kind: "discovery" }
  | { readonly id: Ulid; readonly kind: "get" }
  | { readonly kind: "create"; readonly user: NewDirectoryUser }
  | { readonly kind: "list"; readonly query: DirectoryUserQuery };

export interface ScimRequest {
  /** The decoded JSON body; undefined when the method carries none. */
  readonly body: unknown;
  readonly method: string;
  /** The path segments after `/scim/v2/`, still percent-encoded. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
}

const NOT_FOUND = new ScimError({ detail: "No SCIM resource lives at this path.", status: 404 });
const decodeUlid = Schema.decodeUnknownOption(Ulid);

const FILTER = /^\s*(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/iu;
const FILTER_ATTRIBUTES: ReadonlyMap<string, DirectoryUserAttribute> = new Map([
  ["externalid", "externalId"],
  ["username", "userName"],
]);

function methodNotAllowed(allowed: string) {
  return new ScimError({
    detail: `This resource accepts ${allowed}.`,
    headers: { allow: allowed },
    status: 405,
  });
}

/** `userName eq "…"` or `externalId eq "…"`, with the attribute and operator in any case. */
function parseFilter(filter: string): DirectoryUserQuery["filter"] | ScimError {
  const match = FILTER.exec(filter);
  const attribute = match?.[1] ? FILTER_ATTRIBUTES.get(match[1].toLowerCase()) : undefined;
  let value: unknown;
  try {
    value = match && attribute ? JSON.parse(`"${match[2]}"`) : undefined;
  } catch {
    value = undefined;
  }
  if (attribute === undefined || typeof value !== "string") {
    return new ScimError({
      detail: 'Only filters of the form userName eq "…" or externalId eq "…" are supported.',
      scimType: "invalidFilter",
      status: 400,
    });
  }
  return { attribute, value };
}

function integerParameter(query: URLSearchParams, name: string): number | undefined | ScimError {
  const raw = query.get(name);
  if (raw === null) return undefined;
  return /^\s*-?\d+\s*$/u.test(raw) ? Number(raw) : invalidValue(`${name} must be an integer.`);
}

/** RFC 7644 §3.4.2.4: startIndex below 1 means 1, a negative count means 0. */
function listQuery(query: URLSearchParams): DirectoryUserQuery | ScimError {
  const filterText = query.get("filter");
  const filter = filterText === null ? undefined : parseFilter(filterText);
  if (filter instanceof ScimError) return filter;
  const startIndex = integerParameter(query, "startIndex");
  if (startIndex instanceof ScimError) return startIndex;
  const count = integerParameter(query, "count");
  if (count instanceof ScimError) return count;
  return {
    count: Math.min(Math.max(count ?? SCIM_MAX_COUNT, 0), SCIM_MAX_COUNT),
    ...(filter ? { filter } : {}),
    startIndex: Math.max(startIndex ?? 1, 1),
  };
}

/** The attributes POST and PUT share. */
function userAttributes(body: unknown) {
  const user = jsonObject(body);
  if (!user) return invalidSyntax("The request body must be a User object.");
  const userName = directoryText("userName", user.userName);
  if (userName instanceof ScimError) return userName;
  const externalId =
    user.externalId === undefined || user.externalId === null
      ? undefined
      : directoryText("externalId", user.externalId);
  if (externalId instanceof ScimError) return externalId;
  const active = user.active === undefined ? undefined : scimBoolean("active", user.active);
  if (active instanceof ScimError) return active;
  const email = chosenEmail(user.emails);
  if (email instanceof ScimError) return email;
  return { active, displayName: displayNameOf(user), email, externalId, userName };
}

function newUser(body: unknown): NewDirectoryUser | ScimError {
  const attributes = userAttributes(body);
  if (attributes instanceof ScimError) return attributes;
  const { active, displayName, externalId, userName } = attributes;
  const fallback = attributes.email === undefined ? emailValue(userName) : attributes.email;
  if (fallback instanceof ScimError) {
    return invalidValue("A user needs an email address in emails, or a userName that is one.");
  }
  return {
    active: active ?? true,
    ...(displayName === undefined ? {} : { displayName }),
    email: fallback,
    ...(externalId === undefined ? {} : { externalId }),
    userName,
  };
}

/**
 * PUT replaces the resource: an absent externalId is cleared. An absent `active` keeps the
 * current state, so a profile update never re-grants access the directory removed.
 */
function replacement(body: unknown): DirectoryUserChange | ScimError {
  const attributes = userAttributes(body);
  if (attributes instanceof ScimError) return attributes;
  const { active, displayName, externalId, userName } = attributes;
  return {
    ...(active === undefined ? {} : { active }),
    ...(displayName === undefined ? {} : { displayName }),
    externalId: externalId ?? null,
    userName,
  };
}

function users(request: ScimRequest): ScimCommand | ScimError {
  switch (request.method) {
    case "GET": {
      const query = listQuery(request.query);
      return query instanceof ScimError ? query : { kind: "list", query };
    }
    case "POST": {
      const user = newUser(request.body);
      return user instanceof ScimError ? user : { kind: "create", user };
    }
    default:
      return methodNotAllowed("GET, POST");
  }
}

function user(request: ScimRequest, rawId: string): ScimCommand | ScimError {
  const id = Option.getOrUndefined(decodeUlid(rawId));
  if (id === undefined) return REFUSAL_ERRORS.user_not_found;
  switch (request.method) {
    case "DELETE":
      return { id, kind: "delete" };
    case "GET":
      return { id, kind: "get" };
    case "PATCH": {
      const change = parsePatch(request.body);
      return change instanceof ScimError ? change : { change, id, kind: "change" };
    }
    case "PUT": {
      const change = replacement(request.body);
      return change instanceof ScimError ? change : { change, id, kind: "change" };
    }
    default:
      return methodNotAllowed("DELETE, GET, PATCH, PUT");
  }
}

function discovery(method: string, document: ScimDiscovery | undefined): ScimCommand | ScimError {
  if (document === undefined) return NOT_FOUND;
  return method === "GET" ? { document, kind: "discovery" } : methodNotAllowed("GET");
}

function decodedSegments(segments: readonly string[]) {
  try {
    return segments.map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

export function parseScimRequest(request: ScimRequest): ScimCommand | ScimError {
  const [resource, id, ...rest] = decodedSegments(request.segments) ?? [];
  if (rest.length > 0) return NOT_FOUND;
  switch (resource) {
    case "Users":
      return id === undefined ? users(request) : user(request, id);
    case "ServiceProviderConfig":
      return discovery(request.method, id === undefined ? "service-provider-config" : undefined);
    case "ResourceTypes":
      return discovery(
        request.method,
        id === undefined ? "resource-types" : id === "User" ? "user-resource-type" : undefined,
      );
    case "Schemas":
      return discovery(
        request.method,
        id === undefined ? "schemas" : id === SCIM_USER_SCHEMA ? "user-schema" : undefined,
      );
    default:
      return NOT_FOUND;
  }
}
