/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const wake = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", wake);
    resolve();
  };
  const timer = setTimeout(wake, ms);
  signal.addEventListener("abort", wake, { once: true });
  return promise;
}
