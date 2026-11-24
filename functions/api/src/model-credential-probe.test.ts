import { describe, expect, test } from "bun:test";
import { ModelProviderUnavailableError, makeModelKeyProbe } from "./model-credential-probe.ts";

function probeAnswering(status: number) {
  const requests: [string, Record<string, string>][] = [];
  const probe = makeModelKeyProbe({
    request: async (url, headers) => {
      requests.push([url, headers]);
      return new Response('{"data":[]}', { status });
    },
  });
  return { probe, requests };
}

describe("model provider key probe", () => {
  test("lists models with the key at each provider's public endpoint", async () => {
    const { probe, requests } = probeAnswering(200);

    expect(await probe("openai", "sk-proj-1111")).toBe("accepted");
    expect(await probe("openrouter", "sk-or-v1-2222")).toBe("accepted");
    expect(requests).toEqual([
      [
        "https://api.openai.com/v1/models",
        { accept: "application/json", authorization: "Bearer sk-proj-1111" },
      ],
      [
        "https://openrouter.ai/api/v1/models/user",
        { accept: "application/json", authorization: "Bearer sk-or-v1-2222" },
      ],
    ]);
  });

  test("reports a key the provider refuses as rejected", async () => {
    expect(await probeAnswering(401).probe("openai", "sk-bad")).toBe("rejected");
    expect(await probeAnswering(403).probe("openrouter", "sk-bad")).toBe("rejected");
  });

  test("reports a provider outage or unreachable endpoint as unavailable", async () => {
    expect(probeAnswering(503).probe("openai", "sk-proj-1111")).rejects.toThrow(
      new ModelProviderUnavailableError("openai"),
    );
    const unreachable = makeModelKeyProbe({
      request: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(unreachable("openrouter", "sk-or-v1-2222")).rejects.toThrow(
      "The openrouter API could not verify the key; try again later.",
    );
  });
});
