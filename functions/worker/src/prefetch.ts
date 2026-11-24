/** A rejection that settles before the caller awaits is not reported as unhandled. */
export function prefetch<Value>(read: Promise<Value>): Promise<Value> {
  void read.catch(() => undefined);
  return read;
}
