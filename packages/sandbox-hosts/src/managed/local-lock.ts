const leaseOperationTails = new Map<string, Promise<void>>();

export async function acquireLeaseOperationLock(
  leaseId: string,
  acquireDeadline: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const previous = leaseOperationTails.get(leaseId);
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous ? previous.then(() => current) : current;
  leaseOperationTails.set(leaseId, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (leaseOperationTails.get(leaseId) === tail) leaseOperationTails.delete(leaseId);
  };
  if (!previous) return release;

  try {
    await new Promise<void>((resolve, reject) => {
      const remaining = acquireDeadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      const fail = (cause: unknown) => {
        cleanup();
        reject(cause);
      };
      const onAbort = () => fail(signal.reason ?? new Error("Sandbox operation was canceled."));
      previous.then(() => {
        cleanup();
        resolve();
      }, fail);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) return onAbort();
      if (remaining <= 0) return fail(new Error("Sandbox operation lock acquisition timed out."));
      timer = setTimeout(
        () => fail(new Error("Sandbox operation lock acquisition timed out.")),
        remaining,
      );
    });
  } catch (error) {
    release();
    void tail.then(() => {
      if (leaseOperationTails.get(leaseId) === tail) leaseOperationTails.delete(leaseId);
    });
    throw error;
  }
  return release;
}
