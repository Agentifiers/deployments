import "@tanstack/react-start/server-only";
import type { ObservabilityApiRouteName } from "@deployments-ai/api-contract";
import { callRouteOnce, type RouteInput, type RouteResponse } from "./platform-api.ts";
import { retryThrottled, type Sleep } from "./throttle-retry.ts";

/** The hot plane runs at most two concurrent queries per organization (`api.ts`). */
const ORGANIZATION_QUERY_CONCURRENCY = 2;

export type HotPlaneCall = <Name extends ObservabilityApiRouteName>(
  name: Name,
  input: RouteInput<Name>,
) => Promise<RouteResponse<Name>>;

export interface HotPlaneQueueOptions {
  readonly call?: typeof callRouteOnce;
  readonly sleep?: Sleep;
}

/**
 * Observability calls for one server-function invocation. Calls share a two-slot gate so a screen
 * that needs several hot-plane queries never exceeds the organization's concurrency limit on its
 * own. The hot plane queues calls beyond its limits for up to three seconds, so a `429` (other
 * tabs or users keeping its queue full) is rare; it is retried with jittered back-off outside the
 * gate. Other failures propagate unchanged.
 */
export function createHotPlaneQueue(
  accessToken: string,
  options: HotPlaneQueueOptions = {},
): HotPlaneCall {
  const call = options.call ?? callRouteOnce;
  let active = 0;
  const waiting: (() => void)[] = [];

  async function gated<Result>(task: () => Promise<Result>): Promise<Result> {
    while (active >= ORGANIZATION_QUERY_CONCURRENCY) {
      const slot = Promise.withResolvers<void>();
      waiting.push(slot.resolve);
      await slot.promise;
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  // The retry wraps the gate, so a throttled call frees its slot while it backs off.
  return (name, input) =>
    retryThrottled(() => gated(() => call(name, input, accessToken)), options.sleep);
}
