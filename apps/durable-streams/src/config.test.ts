import { describe, expect, test } from "bun:test";

import { durableStreamsRuntimeConfig } from "./config.ts";

describe("Durable Streams runtime configuration", () => {
  test("uses standalone defaults and accepts explicit deployment values", () => {
    expect(
      durableStreamsRuntimeConfig({
        DURABLE_STREAMS_AUTH_TOKEN: "development-token-with-at-least-32-chars",
      }),
    ).toEqual({
      authToken: "development-token-with-at-least-32-chars",
      dataDir: "/data",
      host: "0.0.0.0",
      longPollTimeoutMs: 20_000,
      port: 4437,
    });
    expect(
      durableStreamsRuntimeConfig({
        DEPLOYMENTS_AI_DURABLE_STREAMS_DATA_DIR: "/mnt/durable-streams/",
        DEPLOYMENTS_AI_DURABLE_STREAMS_HOST: "127.0.0.1",
        DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_TOKEN: "deployment-token-with-at-least-32-characters",
        DEPLOYMENTS_AI_DURABLE_STREAMS_LONG_POLL_TIMEOUT_MS: "15000",
        DEPLOYMENTS_AI_DURABLE_STREAMS_PORT: "7443",
      }),
    ).toEqual({
      authToken: "deployment-token-with-at-least-32-characters",
      dataDir: "/mnt/durable-streams",
      host: "127.0.0.1",
      longPollTimeoutMs: 15_000,
      port: 7443,
    });
  });

  test("rejects unsafe paths, hosts, and ports", () => {
    const auth = {
      DURABLE_STREAMS_AUTH_TOKEN: "development-token-with-at-least-32-chars",
    };
    expect(() => durableStreamsRuntimeConfig({})).toThrow("auth token");
    expect(() =>
      durableStreamsRuntimeConfig({
        ...auth,
        DEPLOYMENTS_AI_DURABLE_STREAMS_DATA_DIR: "relative",
      }),
    ).toThrow("absolute path");
    expect(() =>
      durableStreamsRuntimeConfig({
        ...auth,
        DEPLOYMENTS_AI_DURABLE_STREAMS_HOST: "host/name",
      }),
    ).toThrow("host is invalid");
    expect(() =>
      durableStreamsRuntimeConfig({ ...auth, DEPLOYMENTS_AI_DURABLE_STREAMS_PORT: "65536" }),
    ).toThrow("1 through 65535");
  });
});
