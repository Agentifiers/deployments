import "@tanstack/react-start/server-only";
import { sameValue } from "../lib/same-value.ts";
import { PlatformApiError } from "../errors.ts";

/**
 * Whether to send a change made from a form opened at `expectedVersion`. These update routes take
 * no expected version, so the console reads the resource first: a resource that already holds
 * every requested value needs no write (a retried submission that applied lands here), and one
 * that moved past the form's version is refused. A change landing between the read and the write
 * still wins.
 */
export function needsWrite(
  operation: string,
  noun: string,
  current: { readonly values: Readonly<Record<string, unknown>>; readonly version: number },
  changes: Readonly<Record<string, unknown>>,
  expectedVersion: number,
): boolean {
  const applied = Object.entries(changes).every(([field, value]) =>
    sameValue(current.values[field], value),
  );
  if (applied) return false;
  if (current.version === expectedVersion) return true;
  throw new PlatformApiError(operation, {
    code: "version_conflict",
    detail: `Someone changed this ${noun} after you opened the form. Reload it and make your change again.`,
    status: 409,
    title: "Changed since you opened it",
  });
}
