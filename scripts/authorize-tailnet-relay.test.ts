import { describe, expect, test } from "bun:test";
import {
  decodeDeviceList,
  onlineRelayDevice,
  resolveRelayTarget,
  type TailnetDevice,
} from "./authorize-tailnet-relay.ts";

function device(overrides: Partial<TailnetDevice>): TailnetDevice {
  return {
    nodeId: "n1",
    hostname: "example-openai-relay",
    connectedToControl: true,
    keyExpiryDisabled: false,
    created: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("tailnet relay authorization", () => {
  test("prefers flags over environment and requires both values", () => {
    const environment = {
      TAILNET_RELAY_AUTH_KEY_PARAMETER: "/tailnet-relay/openai-relay/auth-key",
      TAILNET_RELAY_HOSTNAME: "env-host",
    };
    expect(resolveRelayTarget(["--hostname", "flag-host"], environment)).toEqual({
      parameterName: "/tailnet-relay/openai-relay/auth-key",
      hostname: "flag-host",
    });
    expect(() => resolveRelayTarget(["--hostname", "flag-host"], {})).toThrow("Usage:");
  });

  test("selects the newest connected device with the relay hostname", () => {
    const devices = [
      device({ nodeId: "old", created: "2026-09-01T00:00:00Z" }),
      device({ nodeId: "new", created: "2026-10-02T00:00:00Z" }),
      device({ nodeId: "offline", created: "2026-10-03T00:00:00Z", connectedToControl: false }),
      device({ nodeId: "other", created: "2026-10-04T00:00:00Z", hostname: "space-black" }),
    ];
    expect(onlineRelayDevice(devices, "example-openai-relay")?.nodeId).toBe("new");
    expect(onlineRelayDevice(devices.slice(2), "example-openai-relay")).toBeUndefined();
  });

  test("rejects a device list without the connection state it polls on", () => {
    const { connectedToControl: _, ...withoutConnection } = device({});
    expect(() => decodeDeviceList({ devices: [withoutConnection] })).toThrow();
  });
});
