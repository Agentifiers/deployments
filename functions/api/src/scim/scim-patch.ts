import type { DirectoryUserChange } from "@deployments-ai/db";
import { directoryText, displayNameOf, jsonObject, scimBoolean } from "./scim-attributes.ts";
import { invalidSyntax, invalidValue, ScimError } from "./scim-error.ts";

/**
 * The User attribute a PATCH path addresses; `ignored` covers attributes the directory does not
 * take from SCIM, emails included, since SCIM never changes a primary email.
 */
type PatchTarget = "active" | "displayName" | "externalId" | "ignored" | "name" | "userName";

/** Maps, not object literals: these are indexed by request text, which may name `constructor`. */
const PATCH_OPS: ReadonlyMap<string, "add" | "remove" | "replace"> = new Map([
  ["add", "add"],
  ["remove", "remove"],
  ["replace", "replace"],
]);

const SIMPLE_TARGETS: ReadonlyMap<string, PatchTarget> = new Map([
  ["active", "active"],
  ["displayname", "displayName"],
  ["externalid", "externalId"],
  ["name", "name"],
  ["name.formatted", "displayName"],
  ["username", "userName"],
]);

const CORE_USER_URN = "urn:ietf:params:scim:schemas:core:2.0:user";
const ATTRIBUTE_PATH = /^([a-z][\w-]*)(?:\[([^[\]]+)\])?(?:\.([a-z][\w-]*))?$/iu;

function invalidPath(path: string) {
  return new ScimError({
    detail: `The path "${path}" is not a valid attribute path.`,
    scimType: "invalidPath",
    status: 400,
  });
}

/** Resolves `[urn:…:]attribute[\[filter\]][.subAttribute]` (RFC 7644 §3.5.2). */
function patchTarget(path: string): PatchTarget | ScimError {
  const bracket = path.indexOf("[");
  const head = bracket === -1 ? path : path.slice(0, bracket);
  const urnEnd = path.toLowerCase().startsWith("urn:") ? head.lastIndexOf(":") : -1;
  const match = ATTRIBUTE_PATH.exec(path.slice(urnEnd + 1));
  if (!match) return invalidPath(path);
  if (urnEnd !== -1 && path.slice(0, urnEnd).toLowerCase() !== CORE_USER_URN) return "ignored";
  const [, attribute = "", filter, subAttribute] = match;
  const name = attribute.toLowerCase();
  const sub = subAttribute?.toLowerCase();
  if (filter !== undefined) return "ignored";
  return SIMPLE_TARGETS.get(sub === undefined ? name : `${name}.${sub}`) ?? "ignored";
}

function assignment(target: PatchTarget, value: unknown): DirectoryUserChange | ScimError {
  switch (target) {
    case "active": {
      const active = scimBoolean("active", value);
      return active instanceof ScimError ? active : { active };
    }
    case "displayName": {
      const displayName = displayNameOf({ displayName: value });
      return displayName === undefined
        ? invalidValue("displayName must be a non-empty string.")
        : { displayName };
    }
    case "externalId": {
      if (value === null) return { externalId: null };
      const externalId = directoryText("externalId", value);
      return externalId instanceof ScimError ? externalId : { externalId };
    }
    case "ignored":
      return {};
    case "name": {
      const displayName = displayNameOf({ name: value });
      return displayName === undefined ? {} : { displayName };
    }
    case "userName": {
      const userName = directoryText("userName", value);
      return userName instanceof ScimError ? userName : { userName };
    }
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

/** Only externalId can be cleared; the display name is kept, and required attributes stay. */
function removal(target: PatchTarget, path: string): DirectoryUserChange | ScimError {
  switch (target) {
    case "externalId":
      return { externalId: null };
    case "displayName":
    case "ignored":
    case "name":
      return {};
    case "active":
    case "userName":
      return new ScimError({
        detail: `The path "${path}" cannot be removed.`,
        scimType: "mutability",
        status: 400,
      });
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

/** Okta sends no path and an object of attributes; each key is itself a path. */
function valueObjectChange(value: unknown): DirectoryUserChange | ScimError {
  const attributes = jsonObject(value);
  if (!attributes) return invalidValue("An operation without a path needs an object value.");
  let change: DirectoryUserChange = {};
  for (const [path, attributeValue] of Object.entries(attributes)) {
    const target = patchTarget(path);
    const next = target instanceof ScimError ? target : assignment(target, attributeValue);
    if (next instanceof ScimError) return next;
    change = { ...change, ...next };
  }
  return change;
}

function operationChange(value: unknown): DirectoryUserChange | ScimError {
  const operation = jsonObject(value);
  const op =
    typeof operation?.op === "string" ? PATCH_OPS.get(operation.op.toLowerCase()) : undefined;
  if (!operation || !op) {
    return invalidSyntax('Each operation needs an op of "add", "replace" or "remove".');
  }
  const { path } = operation;
  if (path === undefined) {
    return op === "remove"
      ? new ScimError({
          detail: "A remove operation needs a path.",
          scimType: "noTarget",
          status: 400,
        })
      : valueObjectChange(operation.value);
  }
  if (typeof path !== "string") return invalidPath(JSON.stringify(path));
  const target = patchTarget(path.trim());
  if (target instanceof ScimError) return target;
  return op === "remove" ? removal(target, path) : assignment(target, operation.value);
}

/**
 * A PatchOp body in either dialect: Okta's path-less value objects and Entra's paths with
 * capitalised ops and string booleans. Later operations override earlier ones.
 */
export function parsePatch(body: unknown): DirectoryUserChange | ScimError {
  const operations = jsonObject(body)?.Operations;
  if (!Array.isArray(operations)) return invalidSyntax("A PatchOp body needs an Operations array.");
  let change: DirectoryUserChange = {};
  for (const operation of operations) {
    const next = operationChange(operation);
    if (next instanceof ScimError) return next;
    change = { ...change, ...next };
  }
  return change;
}
