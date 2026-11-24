import type {
  ConversationErasure,
  ConversationErasureResponse,
} from "@deployments-ai/api-contract/runtime";
import type { PlatformResponse, PlatformSdk } from "./index.ts";
import { PlatformRequestError } from "./index.ts";
import { segment, type RuntimeErasureWaitOptions, type RuntimeSdk } from "./runtime-sdk-client.ts";

type Request = <T>(
  input: Omit<Parameters<PlatformSdk["request"]>[0], "context">,
) => Promise<PlatformResponse<T>>;
type ErasureResponse = PlatformResponse<ConversationErasureResponse>;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const SETTLED: Readonly<Record<ConversationErasure["status"], boolean>> = {
  canceled: true,
  completed: true,
  failed: true,
  pending: false,
  running: false,
};

function delay(milliseconds: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function waitForSettledErasure(
  poll: () => Promise<ErasureResponse>,
  options: RuntimeErasureWaitOptions = {},
): Promise<ErasureResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  for (;;) {
    const response = await poll();
    if (SETTLED[response.data.erasure.status]) return response;
    if (Date.now() >= deadline) {
      throw new PlatformRequestError(
        `Erasure ${response.data.erasure.id} is still ${response.data.erasure.status}.`,
      );
    }
    await delay(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, options.signal);
  }
}

export function createThreadErasures(
  request: Request,
): Pick<RuntimeSdk["threads"], "erase" | "getErasure" | "waitForErasure"> {
  const getErasure = (threadId: string, erasureId: string) =>
    request<ConversationErasureResponse>({
      method: "GET",
      path: `/v1/threads/${segment(threadId)}/erasures/${segment(erasureId)}`,
    });
  return {
    erase: (threadId) =>
      request({ method: "POST", path: `/v1/threads/${segment(threadId)}/erasures` }),
    getErasure,
    waitForErasure: (threadId, erasureId, options) =>
      waitForSettledErasure(() => getErasure(threadId, erasureId), options),
  };
}

export function createEndUserErasures(request: Request): RuntimeSdk["endUsers"] {
  const getErasure = (erasureId: string) =>
    request<ConversationErasureResponse>({
      method: "GET",
      path: `/v1/end-users/erasures/${segment(erasureId)}`,
    });
  return {
    erase: (body) => request({ body, method: "POST", path: "/v1/end-users/erasures" }),
    getErasure,
    waitForErasure: (erasureId, options) =>
      waitForSettledErasure(() => getErasure(erasureId), options),
  };
}
