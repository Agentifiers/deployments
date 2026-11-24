import type { ApiFunction, ApiResult, PgType } from "./api-catalog.ts";

const JSON_TYPES: Readonly<Record<string, string>> = {
  bool: "boolean",
  bpchar: "string",
  bytea: "string",
  char: "string",
  cidr: "string",
  citext: "string",
  date: "string",
  float4: "number",
  float8: "number",
  inet: "string",
  int2: "number",
  int4: "number",
  int8: "number",
  interval: "string",
  json: "JsonValue",
  jsonb: "JsonValue",
  macaddr: "string",
  name: "string",
  numeric: "number",
  oid: "number",
  text: "string",
  time: "string",
  timestamp: "string",
  timestamptz: "string",
  timetz: "string",
  uuid: "string",
  varchar: "string",
};

function scalarType(name: string, kind: string): string {
  if (kind === "e") return "string";
  return Object.hasOwn(JSON_TYPES, name) ? (JSON_TYPES[name] ?? "unknown") : "unknown";
}

export function typescriptType({ base }: PgType): string {
  if (base.element !== null) {
    const element = scalarType(base.element.name, base.element.kind);
    return element === "unknown" ? "unknown[]" : `Array<${element} | null>`;
  }
  return scalarType(base.name, base.kind);
}

function nullable(type: string) {
  return type === "unknown" ? type : `${type} | null`;
}

const RESERVED_WORDS: Readonly<Record<string, true>> = Object.fromEntries(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield"
    .split(" ")
    .map((word) => [word, true]),
);

function rowType(result: Extract<ApiResult, { kind: "row" }>) {
  const fields = result.columns.map(
    (column) => `${JSON.stringify(column.name)}: ${nullable(typescriptType(column.type))}`,
  );
  return `{ ${fields.join("; ")} }`;
}

function resultTypes(fn: ApiFunction): { readonly element: string; readonly returns: string } {
  const element = ((): string => {
    switch (fn.result.kind) {
      case "void":
        return "void";
      case "record":
        return "unknown";
      case "row":
        return rowType(fn.result);
      case "scalar":
        return nullable(typescriptType(fn.result.type));
      default: {
        const exhaustive: never = fn.result;
        return exhaustive;
      }
    }
  })();
  if (fn.result.kind === "void") return { element, returns: "void" };
  return { element, returns: fn.returnsSet ? `Array<${element}>` : element };
}

function renderFunction(fn: ApiFunction): string {
  const { element, returns } = resultTypes(fn);
  const call = `callApi(${JSON.stringify(fn.name)}, args)`;
  const fields = fn.arguments.map(
    (argument) =>
      `${JSON.stringify(argument.name)}${argument.hasDefault ? "?" : ""}: ${nullable(typescriptType(argument.type))}`,
  );
  const argsType = fields.length === 0 ? "Record<string, never>" : `{ ${fields.join("; ")} }`;
  const argsDefault = fn.arguments.every((argument) => argument.hasDefault) ? " = {}" : "";
  const body =
    fn.result.kind === "void"
      ? `  await ${call};`
      : fn.returnsSet
        ? `  return (await ${call}) as Array<${element}>;`
        : `  const [row] = await ${call};\n  return row as ${element};`;
  const reserved = Object.hasOwn(RESERVED_WORDS, fn.name);
  const localName = reserved ? `${fn.name}_` : fn.name;
  const signature = `async function ${localName}(args: ${argsType}${argsDefault}): Promise<${returns}>`;
  const doc = `/** ${fn.schema}.${fn.name}, ${fn.volatility}. */`;
  return reserved
    ? `${doc}\n${signature} {\n${body}\n}\nexport { ${localName} as ${fn.name} };`
    : `${doc}\nexport ${signature} {\n${body}\n}`;
}

const RUNTIME = `export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class PlatformApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds the server asked the caller to wait before retrying, from Retry-After. */
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

function retryAfterSeconds(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(Math.ceil((date - Date.now()) / 1000), 0);
}

async function callApi(name: string, args: object): Promise<unknown[]> {
  const body = JSON.stringify(args);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(\`/_platform/api/\${name}\`, {
      body,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
    if (response.status === 503 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter ?? 1, 30) * 1000));
      continue;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload.error as { code?: string; message?: string })
          : {};
      if (response.status === 401 && error.code === "unauthenticated") {
        const returnTo = window.location.pathname + window.location.search + window.location.hash;
        window.location.assign(\`/_platform/auth/login?return_to=\${encodeURIComponent(returnTo)}\`);
        return new Promise<never>(() => undefined);
      }
      throw new PlatformApiError(
        response.status,
        error.code ?? "http_error",
        error.message ?? response.statusText,
        retryAfter,
      );
    }
    return (payload as { rows: unknown[] }).rows;
  }
}`;

export function renderTypescriptClient(functions: readonly ApiFunction[]): string {
  const header =
    "// Generated by the platform from the app's api and visitor schemas. Do not edit.\n";
  return [header + RUNTIME, ...functions.map(renderFunction)].join("\n\n") + "\n";
}
