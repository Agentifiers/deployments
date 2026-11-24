import { Effect } from "effect";
import { DatabaseError } from "./client-types.ts";
import { RecordDecodeError } from "./records/index.ts";

/**
 * Lifts a database Promise into an Effect for Effect-native callers. Database failures stay in the
 * typed error channel; any other rejection becomes a defect. Pass a thunk so retries and
 * interruption re-run or cancel the call instead of reusing an already-started Promise.
 */
export function fromDatabase<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, DatabaseError | RecordDecodeError> {
  return Effect.tryPromise({ catch: (cause) => cause, try: operation }).pipe(
    Effect.catch((cause) =>
      cause instanceof DatabaseError || cause instanceof RecordDecodeError
        ? Effect.fail(cause)
        : Effect.die(cause),
    ),
  );
}
