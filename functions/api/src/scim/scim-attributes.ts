import { normalizeEmail } from "@deployments-ai/identity";
import { invalidValue, type ScimError } from "./scim-error.ts";

/** The directory stores userName and externalId with this limit. */
const MAX_DIRECTORY_TEXT = 256;

export type JsonObject = Readonly<Record<string, unknown>>;

export function jsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function directoryText(attribute: string, value: unknown): string | ScimError {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_DIRECTORY_TEXT
    ? value
    : invalidValue(
        `${attribute} must be a non-empty string of at most ${MAX_DIRECTORY_TEXT} characters.`,
      );
}

/** Entra sends booleans as the strings "True" and "False". */
export function scimBoolean(attribute: string, value: unknown): boolean | ScimError {
  if (typeof value === "boolean") return value;
  const spelled = typeof value === "string" ? value.toLowerCase() : undefined;
  if (spelled === "true") return true;
  if (spelled === "false") return false;
  return invalidValue(`${attribute} must be true or false.`);
}

/** A lower-cased email address. */
export function emailValue(value: unknown): string | ScimError {
  try {
    if (typeof value !== "string") throw new TypeError("Not a string.");
    return normalizeEmail(value);
  } catch {
    return invalidValue("An email value must be an email address.");
  }
}

/** The primary address, else the work address, else the first. */
export function chosenEmail(emails: unknown): string | ScimError | undefined {
  if (emails === undefined || emails === null) return undefined;
  if (!Array.isArray(emails)) return invalidValue("emails must be an array.");
  const entries: JsonObject[] = [];
  for (const email of emails) {
    const entry = jsonObject(email);
    if (!entry) return invalidValue("Each emails entry must be an object.");
    entries.push(entry);
  }
  const chosen =
    entries.find((entry) => scimBoolean("primary", entry.primary) === true) ??
    entries.find(
      (entry) => typeof entry.type === "string" && entry.type.toLowerCase() === "work",
    ) ??
    entries[0];
  return chosen === undefined ? undefined : emailValue(chosen.value);
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** displayName, else name.formatted, else the given and family names. */
export function displayNameOf(user: JsonObject): string | undefined {
  const name = jsonObject(user.name);
  const joined = [text(name?.givenName), text(name?.familyName)].filter(Boolean).join(" ");
  return text(user.displayName) ?? text(name?.formatted) ?? text(joined);
}
