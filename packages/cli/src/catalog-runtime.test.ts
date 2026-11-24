import { describe, expect, test } from "bun:test";
import { buildRequest } from "./command-runtime.ts";
import { runtimeCommandCatalog } from "./catalog-runtime.ts";

const context = {
  profileName: "default",
  apiUrl: "https://api.example.test",
  mock: false,
} as const;

describe("runtime CLI catalog", () => {
  test("serializes the negative heartbeat busy flag", async () => {
    const spec = runtimeCommandCatalog.heartbeat!.actions.create!;
    const request = await buildRequest(spec, { "no-skip-when-busy": true }, context, {});

    expect(request.body).toEqual({ skipWhenBusy: false });
    expect(
      buildRequest(spec, { "no-skip-when-busy": true, "skip-when-busy": true }, context, {}),
    ).rejects.toThrow("Conflicting values were provided for skipWhenBusy");
  });

  test("serializes nullable update clear flags and rejects conflicting values", async () => {
    const spec = runtimeCommandCatalog["channel-binding"]!.actions.update!;
    const request = await buildRequest(
      spec,
      {
        id: "binding_1",
        "clear-agent-deployment-id": true,
        "clear-external-channel-id": true,
      },
      context,
      {},
    );

    expect(request.body).toEqual({
      agentDeploymentId: null,
      externalChannelId: null,
    });
    expect(
      buildRequest(
        spec,
        {
          id: "binding_1",
          "clear-external-channel-id": true,
          "external-channel-id": "channel_1",
        },
        context,
        {},
      ),
    ).rejects.toThrow("Conflicting values were provided for externalChannelId");
  });

  test("explicitly redacts scoped artifact URLs", () => {
    expect(runtimeCommandCatalog.artifact!.actions.download!.sensitiveOutputFields).toContain(
      "url",
    );
  });
});
