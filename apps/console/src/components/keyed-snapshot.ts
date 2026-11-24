import { useRef } from "react";

export interface KeyedSnapshot<Value> {
  readonly key: string;
  readonly value: Value;
}

/**
 * The value to send with `key`. A resend after a submission that may have applied repeats the
 * value sent under the same key, so the API replays or finishes it; any other submission reads
 * the live value.
 */
export function snapshotFor<Value>(
  held: KeyedSnapshot<Value> | undefined,
  key: string,
  resend: boolean,
  live: Value,
): KeyedSnapshot<Value> {
  return resend && held?.key === key ? held : { key, value: live };
}

/** Holds `snapshotFor` across renders, for an `ActionDialog` `run(idempotencyKey, resend)`. */
export function useKeyedSnapshot<Value>(): (key: string, resend: boolean, live: Value) => Value {
  const held = useRef<KeyedSnapshot<Value> | undefined>(undefined);
  return (key, resend, live) => {
    held.current = snapshotFor(held.current, key, resend, live);
    return held.current.value;
  };
}
