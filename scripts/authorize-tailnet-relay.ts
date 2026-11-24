import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Schema } from "effect";
import { parseArgs } from "node:util";
import { runMain } from "./platform-deploy/process.ts";
import { required } from "./required-environment.ts";

const TAILSCALE_API = "https://api.tailscale.com/api/v2";
const JOIN_TIMEOUT_MS = 10 * 60 * 1000;
const JOIN_POLL_INTERVAL_MS = 10 * 1000;
const USAGE =
  "Usage: bun run tailnet-relay:authorize -- --parameter <ssm-parameter-name> --hostname <tailnet-hostname>";

const TailnetDevice = Schema.Struct({
  nodeId: Schema.String,
  hostname: Schema.String,
  connectedToControl: Schema.Boolean,
  keyExpiryDisabled: Schema.Boolean,
  created: Schema.String,
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const decodeDeviceList = Schema.decodeUnknownSync(
  Schema.Struct({ devices: Schema.Array(TailnetDevice) }),
);
const decodeCreatedKey = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }));

/** Flags win over TAILNET_RELAY_AUTH_KEY_PARAMETER and TAILNET_RELAY_HOSTNAME. */
export function resolveRelayTarget(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) {
  const { values } = parseArgs({
    args: [...args],
    options: { hostname: { type: "string" }, parameter: { type: "string" } },
  });
  const parameterName = (values.parameter ?? environment.TAILNET_RELAY_AUTH_KEY_PARAMETER)?.trim();
  const hostname = (values.hostname ?? environment.TAILNET_RELAY_HOSTNAME)?.trim();
  if (!parameterName || !hostname) throw new Error(USAGE);
  return { parameterName, hostname };
}

/** A replaced relay leaves its old device behind under the same hostname; prefer the newest. */
export function onlineRelayDevice(devices: readonly TailnetDevice[], hostname: string) {
  return devices
    .filter((device) => device.hostname === hostname && device.connectedToControl)
    .toSorted((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
}

async function tailscaleRequest(apiKey: string, path: string, body?: unknown): Promise<unknown> {
  const authorization = { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(
    `${TAILSCALE_API}${path}`,
    body === undefined
      ? { headers: authorization }
      : {
          body: JSON.stringify(body),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Tailscale API ${path} failed with HTTP ${response.status}: ${text}`);
  }
  return text === "" ? undefined : JSON.parse(text);
}

async function onlineDevice(apiKey: string, hostname: string) {
  const { devices } = decodeDeviceList(await tailscaleRequest(apiKey, "/tailnet/-/devices"));
  return onlineRelayDevice(devices, hostname);
}

async function waitForOnlineDevice(apiKey: string, hostname: string) {
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const device = await onlineDevice(apiKey, hostname);
    if (device) return device;
    await Bun.sleep(JOIN_POLL_INTERVAL_MS);
  }
  throw new Error(
    `${hostname} did not join the tailnet within ten minutes. Inspect tailscale-join.service on the relay instance through Session Manager.`,
  );
}

async function main() {
  const target = resolveRelayTarget(process.argv.slice(2), process.env);
  const apiKey = required("TAILSCALE_API_KEY");

  let device = await onlineDevice(apiKey, target.hostname);
  if (device) {
    console.log(`${target.hostname} is already online; no auth key minted.`);
  } else {
    const ssm = new SSMClient({});
    try {
      await ssm.send(new GetParameterCommand({ Name: target.parameterName }));
    } catch (cause) {
      throw new Error(
        `Cannot read ${target.parameterName} in ${await ssm.config.region()}; deploy the relay and set AWS_REGION to its region.`,
        { cause },
      );
    }
    const { key } = decodeCreatedKey(
      await tailscaleRequest(apiKey, "/tailnet/-/keys", {
        capabilities: {
          devices: { create: { reusable: false, ephemeral: false, preauthorized: true } },
        },
        expirySeconds: 3600,
        description: "deployments-ai tailnet relay",
      }),
    );
    await ssm.send(
      new PutParameterCommand({
        Name: target.parameterName,
        Overwrite: true,
        Type: "SecureString",
        Value: key,
      }),
    );
    console.log(
      `Wrote a single-use auth key to ${target.parameterName}; waiting for ${target.hostname} to join.`,
    );
    device = await waitForOnlineDevice(apiKey, target.hostname);
  }

  if (!device.keyExpiryDisabled) {
    await tailscaleRequest(apiKey, `/device/${device.nodeId}/key`, {
      keyExpiryDisabled: true,
    });
  }
  console.log(`${target.hostname} (${device.nodeId}) is online with node key expiry disabled.`);
}

if (import.meta.main) runMain(main);
