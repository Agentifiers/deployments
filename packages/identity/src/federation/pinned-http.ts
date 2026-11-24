import {
  NetSecurityError,
  executePinnedHttpRequest,
  readBoundedRawBody,
  resolvePublicHttpsTarget,
} from "@deployments-ai/net-security";

import { FederationError } from "./errors.ts";
import type { FederationHttp, FederationHttpRequest, FederationHttpResponse } from "./http.ts";

/** DNS resolution ignores the signal, so the whole request races it to keep the deadline honest. */
function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const abort = () => deadline.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return Promise.race([work, deadline.promise]).finally(() =>
    signal.removeEventListener("abort", abort),
  );
}

export function pinnedFederationHttp(
  options: { readonly timeoutMs?: number; readonly maxBodyBytes?: number } = {},
): FederationHttp {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1_024;

  async function send(
    request: FederationHttpRequest,
    signal: AbortSignal,
  ): Promise<FederationHttpResponse> {
    const target = await resolvePublicHttpsTarget(request.url);
    const response = await executePinnedHttpRequest({
      addresses: target.addresses,
      headers: { ...request.headers },
      method: request.method,
      signal,
      url: target.url,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const body = await readBoundedRawBody(response.body, {
      contentLengthHeader: response.headers.get("content-length"),
      maxBytes: maxBodyBytes,
    });
    return {
      body: new TextDecoder().decode(body),
      headers: response.headers,
      status: response.status,
    };
  }

  return async (request) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await withinDeadline(send(request, signal), signal);
    } catch (cause) {
      throw new FederationError(
        cause instanceof NetSecurityError ? "idp_url_not_allowed" : "idp_request_failed",
        { cause },
      );
    }
  };
}
