import Table from "cli-table3";
import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import type { CliIo, OutputKind, ResolvedCliContext } from "./types.ts";
const SECRET_KEYS = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "authorizationcode",
  "bearertoken",
  "clientsecret",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "signingsecret",
  "token",
  "url",
  "urls",
  "webhooksecret",
]);

const SAFE_URL_KEYS = new Set([
  "authorizationurl",
  "authorizeurl",
  "callbackurl",
  "oauthauthorizationurl",
  "redirecturi",
]);

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SAFE_URL_KEYS.has(normalized)) return false;
  if (/(count|suffix|usage|visibleonce)$/u.test(normalized)) return false;
  if (
    /^(billable|cached|completion|contextwindow|input|maximumoutput|minprompt|output|prompt|reasoning|remaining|total|used)tokens?$/u.test(
      normalized,
    ) ||
    normalized.endsWith("usdpermilliontokens")
  ) {
    return false;
  }
  if (SECRET_KEYS.has(normalized)) return true;
  if (/tokens?$/u.test(normalized)) return true;
  return /(accessurls?|accesstoken|apikey|authorizationcode|bearertoken|clientsecret|credential|credentials|downloadurls?|idtoken|password|presignedurls?|privatekey(?:pem)?|refreshtoken|scopedurls?|secretaccesskey|secretkey|sessiontoken|signedurls?|signingsecret|uploadurls?|webhooksecret)$/u.test(
    normalized,
  );
}

function sanitizeTerminalCharacters(value: string): string {
  let sanitized = "";
  for (const character of stripVTControlCharacters(value)) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      sanitized += " ";
      continue;
    }
    if (
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      continue;
    }
    sanitized += character;
  }
  return sanitized;
}

export function sanitizeTerminalText(value: string): string {
  return sanitizeTerminalCharacters(value).replaceAll(/\s+/gu, " ").trim();
}

/** Sanitizes multi-line text for terminal display while keeping line breaks and indentation. */
export function sanitizeTerminalLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => sanitizeTerminalCharacters(line).trimEnd());
}

function redactValue(
  value: unknown,
  sensitivePrimitive: boolean,
  sensitiveFields: ReadonlySet<string>,
): unknown {
  if (value === null) return value;
  if (typeof value !== "object") return sensitivePrimitive ? "[REDACTED]" : value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, sensitivePrimitive, sensitiveFields));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) || sensitiveFields.has(normalizedKey(key))
        ? "[REDACTED]"
        : redactValue(item, false, sensitiveFields),
    ]),
  );
}

export function redactSecrets(
  value: unknown,
  reveal = false,
  sensitivePrimitive = false,
  sensitiveFields: readonly string[] = [],
): unknown {
  if (reveal || value === null) return value;
  return redactValue(value, sensitivePrimitive, new Set(sensitiveFields.map(normalizedKey)));
}

function sanitizeHumanValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (Array.isArray(value)) return value.map(sanitizeHumanValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeTerminalText(key),
        sanitizeHumanValue(item),
      ]),
    );
  }
  return value;
}

function printable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(sanitizeHumanValue(value));
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return sanitizeTerminalText(value.toString());
  // Functions have no printable data representation (JSON output drops them too).
  return "";
}

function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function rowValue(item: Record<string, unknown>, key: string): string {
  return printable(item[key] ?? "");
}

function renderList(
  data: unknown,
  color: boolean,
  listField = "items",
  configuredColumns?: readonly string[],
): string {
  const nextCursor =
    typeof data === "object" &&
    data !== null &&
    typeof (data as { nextCursor?: unknown }).nextCursor === "string"
      ? printable((data as { nextCursor: string }).nextCursor)
      : "";
  const collection = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[listField]
      : undefined;
  const items = Array.isArray(collection)
    ? (collection.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      ) as Record<string, unknown>[])
    : [];
  if (items.length === 0) {
    const empty = color ? pc.dim("No resources found.") : "No resources found.";
    return nextCursor
      ? `${empty}\n${color ? pc.dim(`Next cursor: ${nextCursor}`) : `Next cursor: ${nextCursor}`}`
      : empty;
  }
  const preferredColumns = ["id", "name", "status", "updatedAt"].filter((column) =>
    items.some((item) => item[column] !== undefined),
  );
  const columns =
    configuredColumns && configuredColumns.length > 0
      ? configuredColumns
      : preferredColumns.length > 0
        ? preferredColumns
        : [...new Set(items.flatMap((item) => Object.keys(item)))].slice(0, 4);
  const table = new Table({
    head: columns.map((column) => {
      const heading = sanitizeTerminalText(column).toUpperCase();
      return color ? pc.bold(heading) : heading;
    }),
    style: { head: [], border: [] },
    wordWrap: true,
  });
  for (const item of items) table.push(columns.map((column) => rowValue(item, column)));
  const rendered = table.toString();
  return nextCursor
    ? `${rendered}\n${color ? pc.dim(`Next cursor: ${nextCursor}`) : `Next cursor: ${nextCursor}`}`
    : rendered;
}

function renderDetail(data: unknown, color: boolean): string {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return printable(data);
  const table = new Table({
    colWidths: [24, 76],
    style: { head: [], border: [] },
    wordWrap: true,
  });
  for (const [key, value] of Object.entries(data)) {
    const safeKey = sanitizeTerminalText(key);
    table.push([color ? pc.bold(safeKey) : safeKey, printable(value)]);
  }
  return table.toString();
}

function objectAt(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Every destination an approval's `request.destinations` names, one full line each, for the person
 * deciding it. A table cell would cut a long URL, so these print below the table.
 */
export function approvalDestinationLines(approval: unknown): string[] {
  const { id, request } = objectAt(approval);
  const destinations = objectAt(request).destinations;
  if (!Array.isArray(destinations)) return [];
  const lines = destinations.flatMap((destination) =>
    typeof destination === "string" ? [`  ${sanitizeTerminalText(destination)}`] : [],
  );
  if (lines.length === 0) return [];
  const label = typeof id === "string" ? ` ${sanitizeTerminalText(id)}` : "";
  return [`Approval${label} sends data to these destinations:`, ...lines];
}

/** The approvals a response shows: one approval, a resolution's approval, or a list of them. */
function approvalsIn(data: unknown): unknown[] {
  const object = objectAt(data);
  if (object.object === "approval") return [object];
  if (objectAt(object.approval).object === "approval") return [object.approval];
  return Array.isArray(object.approvals) ? object.approvals : [];
}

export interface RenderOutputOptions {
  readonly data: unknown;
  readonly io: CliIo;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
  readonly reveal: boolean;
  readonly kind: OutputKind;
  readonly listField?: string;
  readonly columns?: readonly string[];
  readonly requestId?: string;
  readonly context?: ResolvedCliContext;
  readonly sensitive?: boolean;
  readonly sensitiveFields?: readonly string[];
}

export function renderOutput(options: RenderOutputOptions) {
  if (options.quiet) return;
  const data = redactSecrets(
    options.data,
    options.reveal,
    options.sensitive === true,
    options.sensitiveFields,
  );
  if (options.json) {
    options.io.stdout(stringifyJson(data, 2));
    return;
  }
  if (options.context?.mock) {
    options.io.stdout(options.color ? pc.bgYellow(pc.black(" MOCK ")) : "[MOCK]");
  }
  options.io.stdout(
    options.kind === "list"
      ? renderList(data, options.color, options.listField, options.columns)
      : renderDetail(data, options.color),
  );
  for (const line of approvalsIn(data).flatMap(approvalDestinationLines)) {
    options.io.stdout(line);
  }
  if (options.requestId) {
    const requestId = sanitizeTerminalText(options.requestId);
    if (requestId) {
      options.io.stdout(options.color ? pc.dim(`request ${requestId}`) : `request ${requestId}`);
    }
  }
}

export function renderStreamEvent(options: Omit<RenderOutputOptions, "kind" | "requestId">) {
  if (options.quiet) return;
  const data = redactSecrets(
    options.data,
    options.reveal,
    options.sensitive === true,
    options.sensitiveFields,
  );
  if (options.json) {
    options.io.stdout(stringifyJson(data));
    return;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    options.io.stdout(printable(data));
    return;
  }
  const event = data as Record<string, unknown>;
  const timestamp = printable(event.createdAt ?? event.occurredAt ?? event.timestamp);
  const type = printable(event.type ?? event.eventType ?? "event");
  const details = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) => !["createdAt", "eventType", "occurredAt", "timestamp", "type"].includes(key),
    ),
  );
  const prefix = [timestamp, type].filter(Boolean).join("  ");
  const line = `${prefix}${Object.keys(details).length > 0 ? `  ${printable(details)}` : ""}`;
  options.io.stdout(
    options.color ? `${pc.dim(timestamp)}  ${pc.cyan(type)}${line.slice(prefix.length)}` : line,
  );
}
