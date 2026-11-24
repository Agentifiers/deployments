import "@tanstack/react-start/server-only";
import {
  PUBLIC_API_SCHEMAS,
  type PublicApiSchemaName,
  type PublicApiScopeHeaders,
} from "@deployments-ai/api-contract";
import { ProblemDetails } from "@deployments-ai/api-contract/primitives";
import {
  publicRouteContract,
  type PUBLIC_API_ROUTES,
  type PublicRouteName,
} from "@deployments-ai/api-contract/product";
import type { TENANCY_API_ROUTES } from "@deployments-ai/api-contract/routes";
import { Option, Schema } from "effect";
import { PlatformApiError, UnauthenticatedError, type PlatformProblem } from "../errors.ts";
import { consoleConfig } from "./config.ts";
import { retryThrottled } from "./throttle-retry.ts";

type RegistryRoute = (typeof PUBLIC_API_ROUTES)[number];
type TenancyRoute = (typeof TENANCY_API_ROUTES)[number];
type TenancyRouteName = TenancyRoute["name"];

interface RouteShape {
  readonly idempotency: "none" | "optional" | "required" | "required-or-body";
  readonly path: string;
  readonly queryNames: string;
  readonly requestBody: PublicApiSchemaName | undefined;
  readonly requestBodyRequired: boolean;
  readonly responseBody: PublicApiSchemaName;
  readonly scopeHeaders: PublicApiScopeHeaders;
}

/**
 * `PUBLIC_TENANCY_API_ROUTES` widens the tenancy literals while adapting them to the public
 * contract, so tenancy operations read their literals from `TENANCY_API_ROUTES` and apply the
 * same adaptation (`idempotent` → `required`, list routes take `cursor`/`limit`).
 */
type TenancyShape<Route extends TenancyRoute> = {
  readonly idempotency: Route["idempotent"] extends true ? "required" : "none";
  readonly path: Route["path"];
  readonly queryNames: Route["method"] extends "GET"
    ? Route["name"] extends `list${string}`
      ? "cursor" | "limit"
      : never
    : never;
  readonly requestBody: Route extends {
    readonly requestBody: infer Body extends PublicApiSchemaName;
  }
    ? Body
    : undefined;
  readonly requestBodyRequired: Route extends { readonly requestBodyRequired: false }
    ? false
    : true;
  readonly responseBody: Route["responseBody"];
  readonly scopeHeaders: Route["scope"];
};

type RegistryShape<Route extends RegistryRoute> = {
  readonly idempotency: Route["idempotency"];
  readonly path: Route["path"];
  // Some route helpers add `queryParameters` with a conditional spread, so it is optional.
  readonly queryNames: Route extends { readonly queryParameters?: infer Parameters }
    ? NonNullable<Parameters> extends readonly (infer Parameter extends {
        readonly name: string;
      })[]
      ? Parameter["name"]
      : never
    : never;
  readonly requestBody: Route extends {
    readonly requestBody: infer Body extends PublicApiSchemaName;
  }
    ? Body
    : undefined;
  readonly requestBodyRequired: Route extends { readonly requestBodyRequired: false }
    ? false
    : true;
  readonly responseBody: Route["responseBody"] extends PublicApiSchemaName
    ? Route["responseBody"]
    : never;
  readonly scopeHeaders: Route["scopeHeaders"];
};

/** Registry entries declaring `Name`; some helpers declare several operations with a name union. */
type RegistryRouteNamed<Route, Name extends PublicRouteName> = Route extends {
  readonly name: infer Declared;
}
  ? Name extends Declared
    ? Route
    : never
  : never;

/** Literal contract fields of one public operation. */
type RouteShapeOf<Name extends PublicRouteName> = Name extends TenancyRouteName
  ? TenancyShape<Extract<TenancyRoute, { readonly name: Name }>>
  : RegistryShape<RegistryRouteNamed<RegistryRoute, Name>>;

type SchemaType<Name extends PublicApiSchemaName> = (typeof PUBLIC_API_SCHEMAS)[Name]["Type"];

type PathParameterNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParameterNames<`/${Rest}`>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

/** Tenant headers derived from the console URL context. */
interface ConsoleScope {
  readonly environmentId?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
}

type RequiredScope<Headers extends PublicApiScopeHeaders> = Headers extends "organization"
  ? { readonly organizationId: string }
  : Headers extends "project"
    ? { readonly organizationId: string; readonly projectId: string }
    : Headers extends "environment" | "optional-tenant" | "tenant"
      ? {
          readonly environmentId: string;
          readonly organizationId: string;
          readonly projectId: string;
        }
      : unknown;

type PathInput<Shape extends RouteShape> = [PathParameterNames<Shape["path"]>] extends [never]
  ? { readonly path?: never }
  : { readonly path: Readonly<Record<PathParameterNames<Shape["path"]>, string>> };

type QueryInput<Shape extends RouteShape> = [Shape["queryNames"]] extends [never]
  ? { readonly query?: never }
  : {
      readonly query?: Readonly<
        Partial<Record<Shape["queryNames"], boolean | number | string | undefined>>
      >;
    };

type BodyInput<Shape extends RouteShape> = Shape["requestBody"] extends PublicApiSchemaName
  ? Shape["requestBodyRequired"] extends false
    ? { readonly body?: SchemaType<Shape["requestBody"]> }
    : { readonly body: SchemaType<Shape["requestBody"]> }
  : { readonly body?: never };

type ScopeInput<Shape extends RouteShape> =
  unknown extends RequiredScope<Shape["scopeHeaders"]>
    ? { readonly scope?: ConsoleScope }
    : { readonly scope: ConsoleScope & RequiredScope<Shape["scopeHeaders"]> };

type IdempotencyInput<Shape extends RouteShape> = Shape["idempotency"] extends "required"
  ? { readonly idempotencyKey: string }
  : Shape["idempotency"] extends "none"
    ? { readonly idempotencyKey?: never }
    : { readonly idempotencyKey?: string };

export const RAW_CONTENT_ROUTES = { uploadBrainContent: true } as const satisfies Partial<
  Record<PublicRouteName, true>
>;

export interface RawContent {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

type ContentInput<Name extends PublicRouteName> = Name extends keyof typeof RAW_CONTENT_ROUTES
  ? { readonly content: RawContent }
  : { readonly content?: never };

/** Request input of one operation: path parameters, query, body, tenant scope, idempotency key. */
export type RouteInput<Name extends PublicRouteName> = PathInput<RouteShapeOf<Name>> &
  QueryInput<RouteShapeOf<Name>> &
  BodyInput<RouteShapeOf<Name>> &
  ContentInput<Name> &
  ScopeInput<RouteShapeOf<Name>> &
  IdempotencyInput<RouteShapeOf<Name>>;

/** Decoded success body of one operation. */
export type RouteResponse<Name extends PublicRouteName> = SchemaType<
  RouteShapeOf<Name>["responseBody"]
>;

interface UntypedRouteInput {
  readonly body?: unknown;
  readonly content?: RawContent;
  readonly idempotencyKey?: string;
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, boolean | number | string | undefined>>;
  readonly scope?: ConsoleScope;
}

/** The platform API could not be reached or answered outside its contract. */
export class PlatformRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformRequestError";
  }
}

/** The registry's schemas widened to plain JSON codecs (`Codec` is covariant in its types). */
const SCHEMAS: Readonly<Record<PublicApiSchemaName, Schema.Codec<unknown, unknown>>> =
  PUBLIC_API_SCHEMAS;

function requestPath(operation: string, template: string, values: UntypedRouteInput["path"]) {
  return template.replaceAll(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name: string) => {
    const value = values?.[name];
    if (!value) throw new TypeError(`${operation} requires the path parameter "${name}".`);
    return encodeURIComponent(value);
  });
}

const decodeProblem = Schema.decodeUnknownOption(ProblemDetails);

/**
 * The longest delay a browser timer holds, 2^31 - 1 milliseconds. A longer Retry-After is dropped,
 * not clamped, so a domain check falls back to its own back-off instead of the 10-minute cap.
 */
const MAX_RETRY_AFTER_SECONDS = 2_147_483;

async function problemFrom(response: Response): Promise<PlatformProblem> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined;
  }
  const fallbackRequestId = response.headers.get("x-request-id") ?? undefined;
  const retryAfter = Number(/^\d+$/u.exec(response.headers.get("retry-after") ?? "")?.[0]);
  const retryAfterSeconds =
    retryAfter <= MAX_RETRY_AFTER_SECONDS ? { retryAfterSeconds: retryAfter } : {};
  const decoded = Option.getOrUndefined(decodeProblem(payload));
  if (!decoded) {
    return {
      status: response.status,
      title: response.statusText || "Platform API request failed",
      ...(fallbackRequestId ? { requestId: fallbackRequestId } : {}),
      ...retryAfterSeconds,
    };
  }
  const requestId = decoded.requestId ?? fallbackRequestId;
  return {
    status: decoded.status,
    title: decoded.title,
    ...(decoded.code === undefined ? {} : { code: decoded.code }),
    ...(decoded.detail === undefined ? {} : { detail: decoded.detail }),
    ...(decoded.instance === undefined ? {} : { instance: decoded.instance }),
    ...(requestId === undefined ? {} : { requestId }),
    ...retryAfterSeconds,
    ...(decoded.type === undefined ? {} : { type: decoded.type }),
  };
}

export interface PlatformApiClientOptions {
  /** Platform API origin. */
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PlatformApiClient {
  callRoute<Name extends PublicRouteName>(
    name: Name,
    input: RouteInput<Name>,
    accessToken: string,
  ): Promise<RouteResponse<Name>>;
}

export function createPlatformApiClient(options: PlatformApiClientOptions): PlatformApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function call(name: PublicRouteName, input: UntypedRouteInput, accessToken: string) {
    const contract = publicRouteContract(name);
    if (contract.server !== undefined) {
      throw new TypeError(`${name} is served by ${contract.server}, not the platform API.`);
    }
    if ((contract.responseContentType ?? "application/json") !== "application/json") {
      throw new TypeError(`${name} does not return JSON; callRoute only serves JSON operations.`);
    }
    const url = new URL(requestPath(name, contract.path, input.path), options.baseUrl);
    const allowedQuery = new Set(contract.queryParameters?.map((parameter) => parameter.name));
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (!allowedQuery.has(key)) throw new TypeError(`${name} has no query parameter "${key}".`);
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    if (input.content !== undefined && !Object.hasOwn(RAW_CONTENT_ROUTES, name)) {
      throw new TypeError(`${name} takes a JSON body, not raw content.`);
    }
    const body =
      input.content?.bytes ??
      (input.body === undefined || contract.requestBody === undefined
        ? undefined
        : JSON.stringify(
            Schema.encodeSync(SCHEMAS[contract.requestBody as PublicApiSchemaName])(input.body),
          ));
    const contentType = input.content?.contentType ?? "application/json";

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...(body === undefined ? {} : { body }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": contentType }),
          ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
          ...(input.scope?.organizationId
            ? { "x-deployments-organization": input.scope.organizationId }
            : {}),
          ...(input.scope?.projectId ? { "x-deployments-project": input.scope.projectId } : {}),
          ...(input.scope?.environmentId
            ? { "x-deployments-environment": input.scope.environmentId }
            : {}),
        },
        method: contract.method,
        redirect: "error",
      });
    } catch (cause) {
      throw new PlatformRequestError(`Unable to reach the platform API for ${name}.`, { cause });
    }

    if (response.status === 401) {
      await response.body?.cancel();
      throw new UnauthenticatedError();
    }
    if (!response.ok) throw new PlatformApiError(name, await problemFrom(response));

    let payload: unknown = null;
    try {
      if (response.status !== 204) payload = await response.json();
    } catch (cause) {
      throw new PlatformRequestError(`The platform API returned malformed JSON for ${name}.`, {
        cause,
      });
    }
    try {
      return Schema.decodeUnknownSync(SCHEMAS[contract.responseBody as PublicApiSchemaName])(
        payload,
      );
    } catch (cause) {
      throw new PlatformRequestError(
        `The platform API returned a ${name} response outside its contract.`,
        { cause },
      );
    }
  }

  return {
    callRoute: (name, input, accessToken) =>
      call(name, input as UntypedRouteInput, accessToken) as Promise<never>,
  };
}

let defaultClient: PlatformApiClient | undefined;

function defaultApiClient() {
  defaultClient ??= createPlatformApiClient({ baseUrl: consoleConfig().platformApiUrl });
  return defaultClient;
}

/**
 * Calls one public platform operation with the caller's access token. Path, query, body, and
 * tenant scope are typed from `PUBLIC_API_ROUTES`; the response is decoded with the registry's
 * Effect schema. A `429` (API Gateway throttling, hot-plane caps) means nothing was processed,
 * so it is retried with jittered back-off for every operation. Failures throw `PlatformApiError`
 * (problem envelope), `UnauthenticatedError` (401), or `PlatformRequestError` (transport or
 * contract violation).
 */
export function callRoute<Name extends PublicRouteName>(
  name: Name,
  input: RouteInput<Name>,
  accessToken: string,
): Promise<RouteResponse<Name>> {
  return retryThrottled(() => defaultApiClient().callRoute(name, input, accessToken));
}

/** One attempt of `callRoute`, for callers that schedule their own `429` retries. */
export function callRouteOnce<Name extends PublicRouteName>(
  name: Name,
  input: RouteInput<Name>,
  accessToken: string,
): Promise<RouteResponse<Name>> {
  return defaultApiClient().callRoute(name, input, accessToken);
}

/** Follows `nextCursor` until the list is exhausted. */
export async function collectPages<Item>(
  fetchPage: (cursor: string | undefined) => Promise<{
    readonly items: readonly Item[];
    readonly nextCursor?: string | null | undefined;
  }>,
): Promise<Item[]> {
  const items: Item[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor !== undefined && seen.has(cursor)) {
      throw new PlatformRequestError("The platform API repeated a pagination cursor.");
    }
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return items;
}
