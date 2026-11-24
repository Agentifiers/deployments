import { isIPv4, isIPv6 } from "node:net";
import { AppId, type ApiCallResult } from "@deployments-ai/app-database";
import { appIsPublic, type AppRecord } from "@deployments-ai/db";
import { Option, Schema } from "effect";
import {
  answer,
  databaseFailure,
  decodeArguments,
  invalidBody,
  type ApiCallContext,
  type CallOutcome,
} from "./api-calls.ts";
import { apiError, platformPage, type Handled } from "./responses.ts";

export const VIEWER_ADDRESS_HEADER = "x-deployments-viewer-address";
export const VISITOR_DEADLINE_MS = 2_000;
const MAXIMUM_BUCKETS = 100_000;
const PRUNED_SHARE = 0.9;

export interface RateLimit {
  readonly burst: number;
  readonly perMinute: number;
}

type Throttled =
  | { readonly kind: "allowed" }
  | { readonly kind: "limited"; readonly retryAfterSeconds: number };

type Throttle = (key: string) => Throttled;

export interface VisitorGate {
  readonly address: Throttle;
  readonly app: Throttle;
  readonly bodyMaxBytes: number;
  readonly deadlineMs: number;
  readonly page: Throttle;
}

interface VisitorCallContext extends ApiCallContext {
  readonly visitors: VisitorGate;
}

/**
 * A key missing from the map has a full bucket, so a full map first forgets buckets that have
 * refilled, and only then the oldest ones.
 */
export function tokenBuckets(input: {
  readonly limit: RateLimit;
  readonly maximumKeys?: number;
  readonly now: () => Date;
}): Throttle {
  const { limit, maximumKeys = MAXIMUM_BUCKETS, now } = input;
  const buckets = new Map<string, { readonly at: number; readonly tokens: number }>();
  const perMs = limit.perMinute / 60_000;
  const refilled = (bucket: { readonly at: number; readonly tokens: number }, at: number) =>
    Math.min(limit.burst, bucket.tokens + Math.max(0, at - bucket.at) * perMs);
  const prune = (at: number) => {
    for (const [key, bucket] of buckets) {
      if (refilled(bucket, at) >= limit.burst) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size < maximumKeys * PRUNED_SHARE) break;
      buckets.delete(key);
    }
  };
  return (key) => {
    const at = now().getTime();
    const stored = buckets.get(key);
    const tokens = stored === undefined ? limit.burst : refilled(stored, at);
    if (tokens < 1) {
      buckets.set(key, { at, tokens });
      return { kind: "limited", retryAfterSeconds: Math.ceil((1 - tokens) / perMs / 1_000) };
    }
    if (stored === undefined && buckets.size >= maximumKeys) prune(at);
    buckets.set(key, { at, tokens: tokens - 1 });
    return { kind: "allowed" };
  };
}

function ipv6Groups(address: string): number[] {
  const groupsOf = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = "", tail] = address.split("::");
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function viewerKey(address: string | null): string | undefined {
  if (address === null) return undefined;
  if (isIPv4(address)) return address;
  if (!isIPv6(address) || address.includes("%")) return undefined;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = ipv6Groups(address);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${[g0, g1, g2, g3 & 0xff00].map((group) => group.toString(16)).join(":")}::/56`;
}

const VIEWER_ADDRESS_MISSING = "viewer-address-missing";

function rateLimited(reason: string, throttled: { readonly retryAfterSeconds: number }): Handled {
  return {
    reason,
    response: apiError(429, "rate_limited", "Too many calls; retry after the Retry-After delay.", {
      "retry-after": String(throttled.retryAfterSeconds),
    }),
    role: "visitor",
  };
}

export function visitorPageRefusal(visitors: VisitorGate, request: Request): Handled | undefined {
  const viewer = viewerKey(request.headers.get(VIEWER_ADDRESS_HEADER));
  if (viewer === undefined) {
    return {
      reason: VIEWER_ADDRESS_MISSING,
      response: platformPage({
        message: "Visitors must come through the platform's edge.",
        status: 403,
        title: "Access denied",
      }),
      role: "visitor",
    };
  }
  const throttled = visitors.page(viewer);
  if (throttled.kind === "allowed") return undefined;
  const response = platformPage({
    message: "Too many pages were loaded from your network. Wait a moment and reload.",
    status: 429,
    title: "Too many requests",
  });
  response.headers.set("retry-after", String(throttled.retryAfterSeconds));
  return { reason: "rate-limited-page", response, role: "visitor" };
}

async function readBody(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return undefined;
  const bytes = await request.bytes();
  return bytes.byteLength > maxBytes ? undefined : new TextDecoder().decode(bytes);
}

/**
 * The database ends the call by the visitor deadline, so its answer, including
 * `deadline_exceeded`, says whether the call committed. Only a call still waiting for its slots
 * at the deadline is answered early, and it never starts.
 */
async function callByDeadline(
  context: VisitorCallContext,
  appId: AppId,
  call: (deadlineMs: number) => Promise<ApiCallResult>,
): Promise<CallOutcome> {
  const { deadlineMs } = context.visitors;
  const deadline = performance.now() + deadlineMs;
  let gaveUp = false;
  const waiting = Promise.withResolvers<CallOutcome>();
  const timer = setTimeout(() => {
    gaveUp = true;
    waiting.resolve({ kind: "busy" });
  }, deadlineMs);
  const called = context.limits
    .visitor(appId, async (): Promise<CallOutcome> => {
      if (gaveUp) return { kind: "busy" };
      clearTimeout(timer);
      return { kind: "done", value: await call(Math.max(1, deadline - performance.now())) };
    })
    .then((outcome) => (outcome.kind === "busy" ? outcome : outcome.value))
    .catch(databaseFailure);
  called.catch(() => undefined);
  try {
    return await Promise.race([called, waiting.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callAsVisitor(
  context: VisitorCallContext,
  input: {
    readonly app: AppRecord;
    readonly functionName: string;
    /** The caller's own sign-in challenge or refusal, for a function visitors may not call. */
    readonly refusal: () => Handled;
    readonly request: Request;
  },
): Promise<Handled> {
  const { request } = input;
  const { visitors } = context;
  const viewer = viewerKey(request.headers.get(VIEWER_ADDRESS_HEADER));
  if (viewer === undefined) {
    return {
      reason: VIEWER_ADDRESS_MISSING,
      response: apiError(
        403,
        "viewer_address_required",
        "Visitor calls must come through the platform's edge.",
      ),
      role: "visitor",
    };
  }
  const appId = Schema.decodeUnknownSync(AppId)(input.app.data.id);
  const byAddress = visitors.address(`${appId} ${viewer}`);
  if (byAddress.kind === "limited") return rateLimited("rate-limited-address", byAddress);
  const byApp = visitors.app(appId);
  if (byApp.kind === "limited") return rateLimited("rate-limited-app", byApp);
  const body = await readBody(request, visitors.bodyMaxBytes);
  if (body === undefined) {
    return {
      reason: "body-too-large",
      response: apiError(
        413,
        "body_too_large",
        `Visitor calls take at most ${visitors.bodyMaxBytes} bytes of arguments.`,
      ),
      role: "visitor",
    };
  }
  const args = Option.getOrUndefined(decodeArguments(body));
  if (args === undefined) return invalidBody("visitor");
  const outcome = await callByDeadline(context, appId, (deadlineMs) =>
    context.database.callApiFunction({
      appId,
      appIsPublic: appIsPublic(input.app.data),
      args,
      deadlineMs,
      functionName: input.functionName,
      role: "visitor",
    }),
  );
  if (outcome.kind === "failed" && outcome.error.code === "visitor_not_allowed") {
    return { ...input.refusal(), databaseError: outcome.error.message, role: "visitor" };
  }
  return answer(outcome, { detailed: false, role: "visitor" });
}
