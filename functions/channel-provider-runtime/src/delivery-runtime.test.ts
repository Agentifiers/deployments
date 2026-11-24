import { describe, expect, test } from "bun:test";

import {
  CHANNEL_DELIVERY_ENV,
  createChannelDeliveryRuntimeDependencies,
} from "./delivery-runtime.ts";

const authSecretArn = "arn:aws:ssm:us-east-2:123456789012:parameter/durable-streams/auth";

describe("channel delivery runtime composition", () => {
  test("keeps ordinary provider delivery available without external publication", async () => {
    let secretReads = 0;
    const dependencies = await createChannelDeliveryRuntimeDependencies({
      env: {},
      loadSecret: async () => {
        secretReads += 1;
        return "unused";
      },
    });

    expect(dependencies.externalPublication).toBeUndefined();
    expect(dependencies.ingressDispatch).toBeDefined();
    expect(secretReads).toBe(0);
  });

  test("wires confirmed response publication when durable streams are configured", async () => {
    const references: string[] = [];
    const dependencies = await createChannelDeliveryRuntimeDependencies({
      env: {
        [CHANNEL_DELIVERY_ENV.durableAuthSecretArn]: authSecretArn,
        [CHANNEL_DELIVERY_ENV.durableBaseUrl]: "http://streams.internal",
      },
      loadSecret: async (reference) => {
        references.push(reference);
        return "stream-token";
      },
    });

    expect(references).toEqual([authSecretArn]);
    expect(dependencies.externalPublication).toBeDefined();
  });

  test("rejects a partial durable streams configuration", async () => {
    expect(
      createChannelDeliveryRuntimeDependencies({
        env: { [CHANNEL_DELIVERY_ENV.durableBaseUrl]: "http://streams.internal" },
      }),
    ).rejects.toThrow("configured together");
  });
});
