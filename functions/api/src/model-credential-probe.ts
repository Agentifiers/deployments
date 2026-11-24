import type { ByokProvider } from "@deployments-ai/db";
import { executePinnedHttpRequest, resolvePublicHttpsTarget } from "@deployments-ai/net-security";

/** Read-only model listings that answer 401 for a key the provider does not accept. */
const MODEL_LIST_URLS: Readonly<Record<ByokProvider, string>> = {
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models/user",
};

export type ModelKeyVerdict = "accepted" | "rejected";
export type ModelKeyProbe = (provider: ByokProvider, apiKey: string) => Promise<ModelKeyVerdict>;

export class ModelProviderUnavailableError extends Error {
  constructor(provider: ByokProvider, options?: ErrorOptions) {
    super(`The ${provider} API could not verify the key; try again later.`, options);
    this.name = "ModelProviderUnavailableError";
  }
}

type ProbeRequest = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<Response>;

async function pinnedGet(url: string, headers: Record<string, string>, signal: AbortSignal) {
  const target = await resolvePublicHttpsTarget(url);
  return executePinnedHttpRequest({
    addresses: target.addresses,
    headers,
    method: "GET",
    signal,
    url: target.url,
  });
}

/** Lists the provider's models with the key, over pinned public egress, without storing anything. */
export function makeModelKeyProbe(
  options: { readonly request?: ProbeRequest; readonly timeoutMs?: number } = {},
): ModelKeyProbe {
  const request = options.request ?? pinnedGet;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (provider, apiKey) => {
    let response: Response;
    try {
      response = await request(
        MODEL_LIST_URLS[provider],
        { accept: "application/json", authorization: `Bearer ${apiKey}` },
        AbortSignal.timeout(timeoutMs),
      );
    } catch (cause) {
      throw new ModelProviderUnavailableError(provider, { cause });
    }
    await response.body?.cancel();
    if (response.ok) return "accepted";
    if (response.status === 401 || response.status === 403) return "rejected";
    throw new ModelProviderUnavailableError(provider);
  };
}
