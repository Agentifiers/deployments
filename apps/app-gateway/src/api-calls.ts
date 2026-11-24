import {
  AppDatabaseError,
  AppId,
  type ApiCallResult,
  type AppApiGateway,
  type AppDatabaseErrorCode,
} from "@deployments-ai/app-database";
import { appIsPublic, type AppRecord } from "@deployments-ai/db";
import { Option, Schema } from "effect";
import type { Caller, ServedRole } from "./admission.ts";
import { apiError, jsonResponse, type Handled } from "./responses.ts";

export const MAXIMUM_BODY_BYTES = 1024 * 1024;
const RETRY_AFTER = { "retry-after": "5" };

const API_ERRORS: Readonly<
  Record<AppDatabaseErrorCode, { readonly message: string; readonly status: number }>
> = {
  connections_exhausted: { message: "The app is busy; retry shortly.", status: 503 },
  database_unavailable: {
    message: "The app's database is starting; retry in a few seconds.",
    status: 503,
  },
  deadline_exceeded: { message: "The function took too long to answer.", status: 504 },
  function_not_allowed: { message: "Your role cannot call this function.", status: 403 },
  function_not_found: { message: "The app has no such function.", status: 404 },
  idempotency_conflict: { message: "The app could not handle the request.", status: 500 },
  invalid_arguments: {
    message: "The arguments do not match the function's parameters.",
    status: 400,
  },
  key_value_store_conflict: { message: "The app could not handle the request.", status: 500 },
  outcome_unknown: {
    message:
      "The function did not finish in time and may have saved its changes; check before retrying.",
    status: 504,
  },
  postgres_error: { message: "The app's database refused the request.", status: 422 },
  provision_incomplete: { message: "The app's database is not ready yet.", status: 503 },
  result_too_large: { message: "The function's result is too large to return.", status: 413 },
  sql_rejected: { message: "The app could not handle the request.", status: 400 },
  visitor_not_allowed: { message: "Sign in to call this function.", status: 401 },
};

export const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

export type ConcurrencyOutcome<Value> =
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly value: Value };

type ApiCallLimit = <Value>(
  share: string,
  work: () => Promise<Value>,
) => Promise<ConcurrencyOutcome<Value>>;

export interface ApiCallLimits {
  readonly caller: ApiCallLimit;
  readonly visitor: ApiCallLimit;
}

class Slots {
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(private readonly maximum: number) {}

  get idle() {
    return this.#active === 0 && this.#waiting.length === 0;
  }

  acquire(waitMs: number): Promise<boolean> {
    if (this.#active < this.maximum) {
      this.#active += 1;
      return Promise.resolve(true);
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const grant = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      this.#waiting.splice(this.#waiting.indexOf(grant), 1);
      resolve(false);
    }, waitMs);
    this.#waiting.push(grant);
    return promise;
  }

  release() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active -= 1;
  }
}

async function holding<Value>(
  slots: readonly Slots[],
  waitMs: number,
  work: () => Promise<Value>,
): Promise<ConcurrencyOutcome<Value>> {
  const [first, ...rest] = slots;
  if (first === undefined) return { kind: "done", value: await work() };
  if (!(await first.acquire(waitMs))) return { kind: "busy" };
  try {
    return await holding(rest, waitMs, work);
  } finally {
    first.release();
  }
}

export function apiCallLimits(input: {
  readonly callerShare: number;
  readonly total: number;
  readonly visitorShare: number;
  readonly visitorTotal: number;
  readonly waitMs: number;
}): ApiCallLimits {
  const total = new Slots(input.total);
  const visitors = new Slots(input.visitorTotal);
  function lane(perShare: number, pools: readonly Slots[]): ApiCallLimit {
    const shares = new Map<string, Slots>();
    return async (key, work) => {
      const share = shares.get(key) ?? new Slots(perShare);
      shares.set(key, share);
      try {
        return await holding([share, ...pools], input.waitMs, work);
      } finally {
        if (share.idle) shares.delete(key);
      }
    };
  }
  return {
    caller: lane(input.callerShare, [total]),
    visitor: lane(input.visitorShare, [visitors, total]),
  };
}

export interface ApiCallContext {
  readonly database: Pick<AppApiGateway, "callApiFunction">;
  readonly limits: ApiCallLimits;
}

const CROSS_SITE_MESSAGES = {
  cookie: "API calls with a session cookie must come from the app's own pages.",
  visitor: "Visitor calls must come from the app's own pages.",
} as const;

/**
 * Cookie requests must come from the app's own pages: a sibling app on the same site would
 * otherwise send the member's cookie with a form post or a no-cors fetch.
 */
export function crossSiteRefusal(
  request: Request,
  sender: keyof typeof CROSS_SITE_MESSAGES,
): Handled | undefined {
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    return {
      reason: "cross-site",
      response: apiError(403, "cross_site_request", CROSS_SITE_MESSAGES[sender]),
    };
  }
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return {
      reason: "content-type",
      response: apiError(
        403,
        "json_required",
        "API calls must send Content-Type: application/json.",
      ),
    };
  }
  return undefined;
}

export function invalidBody(role: ServedRole): Handled {
  return {
    reason: "invalid-body",
    response: apiError(
      400,
      "invalid_request",
      "The body must be a JSON object of named arguments.",
    ),
    role,
  };
}

export type CallOutcome =
  | ConcurrencyOutcome<ApiCallResult>
  | { readonly error: AppDatabaseError; readonly kind: "failed" };

export function databaseFailure(error: unknown) {
  if (error instanceof AppDatabaseError) return { error, kind: "failed" } as const;
  throw error;
}

export function answer(
  outcome: CallOutcome,
  input: { readonly detailed: boolean; readonly role: ServedRole },
): Handled {
  const { role } = input;
  switch (outcome.kind) {
    case "busy":
      return {
        reason: "gateway-busy",
        response: apiError(503, "gateway_busy", "The app is busy; retry shortly.", RETRY_AFTER),
        role,
      };
    case "done":
      return {
        response: jsonResponse(200, { rows: outcome.value.rows }),
        role,
        rows: outcome.value.rows.length,
      };
    case "failed": {
      const { error } = outcome;
      const { message, status } = API_ERRORS[error.code];
      return {
        databaseError: error.message,
        reason: error.code,
        response: apiError(
          status,
          error.code,
          input.detailed ? error.message : message,
          status === 503 ? RETRY_AFTER : {},
        ),
        role,
      };
    }
  }
}

export async function callApi(
  context: ApiCallContext,
  input: {
    readonly app: AppRecord;
    readonly caller: Caller;
    readonly functionName: string;
    readonly request: Request;
  },
): Promise<Handled> {
  const { caller } = input;
  const role = caller.role;
  const body = await input.request.text();
  const args =
    body.length <= MAXIMUM_BODY_BYTES ? Option.getOrUndefined(decodeArguments(body)) : undefined;
  if (args === undefined) return invalidBody(role);
  const appId = Schema.decodeUnknownSync(AppId)(input.app.data.id);
  const outcome = await context.limits
    .caller(`${appId}/${role}`, () =>
      context.database.callApiFunction({
        appId,
        appIsPublic: appIsPublic(input.app.data),
        args,
        functionName: input.functionName,
        principal:
          caller.kind === "member"
            ? { email: caller.email, id: caller.principalId }
            : { email: null, id: caller.runId },
        role,
      }),
    )
    .catch(databaseFailure);
  return answer(outcome, { detailed: caller.kind === "agent-dev", role });
}
