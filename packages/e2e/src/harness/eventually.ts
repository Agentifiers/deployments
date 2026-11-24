import { Effect } from "effect";
import { setTimeout as delay } from "node:timers/promises";

export interface EventuallyOptions {
  readonly intervalMs?: number;
  readonly label: string;
  readonly timeoutMs: number;
}

export function eventually<A, E, R>(
  options: EventuallyOptions,
  operation: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<A, E | Error, R> {
  return Effect.gen(function* () {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const value = yield* operation;
      if (value !== undefined) return value;
      yield* Effect.promise(() => delay(options.intervalMs ?? 1_000));
    }
    return yield* Effect.fail(
      new Error(`${options.label} did not complete within ${String(options.timeoutMs)}ms.`),
    );
  });
}
