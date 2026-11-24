import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsNativeMemoryConfig, OpenSearchTransport } from "@deployments-ai/memory";
import { SignatureV4 } from "@smithy/signature-v4";
import { createHash, createHmac } from "node:crypto";

class NodeSha256 {
  readonly hash;

  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.hash =
      secret === undefined
        ? createHash("sha256")
        : createHmac(
            "sha256",
            typeof secret === "string"
              ? secret
              : Buffer.from(
                  secret instanceof ArrayBuffer
                    ? secret
                    : secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength),
                ),
          );
  }

  digest() {
    return Promise.resolve(this.hash.digest());
  }

  update(data: string | ArrayBuffer | ArrayBufferView) {
    this.hash.update(data as never);
  }
}

export function openSearchTransport(
  config: Pick<AwsNativeMemoryConfig, "openSearchEndpoint" | "region">,
): OpenSearchTransport {
  const endpoint = new URL(config.openSearchEndpoint);
  const approvedValue = process.env.DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT?.trim();
  if (!approvedValue) {
    throw new TypeError("The OpenTofu-managed OpenSearch endpoint is not configured.");
  }
  const approvedEndpoint = new URL(approvedValue);
  if (endpoint.protocol !== "https:") {
    throw new TypeError("AWS-native OpenSearch endpoint must use HTTPS.");
  }
  if (endpoint.origin !== approvedEndpoint.origin || endpoint.pathname !== "/") {
    throw new TypeError("AWS-native OpenSearch endpoint is not the approved memory domain.");
  }
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: config.region,
    service: "es",
    sha256: NodeSha256,
  });
  return {
    request: async (input) => {
      const url = new URL(input.path, `${endpoint.href.replace(/\/+$/u, "")}/`);
      if (url.origin !== endpoint.origin) {
        throw new TypeError("OpenSearch request escaped the configured endpoint.");
      }
      const body = input.body === undefined ? undefined : JSON.stringify(input.body);
      const headers: Record<string, string> = {
        host: url.host,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      };
      const query = Object.fromEntries([...url.searchParams].map(([name, value]) => [name, value]));
      const signed = await signer.sign({
        ...(body === undefined ? {} : { body }),
        headers,
        hostname: url.hostname,
        method: input.method,
        path: url.pathname,
        ...(url.port ? { port: Number(url.port) } : {}),
        protocol: url.protocol,
        query,
      });
      const response = await fetch(url, {
        ...(body === undefined ? {} : { body }),
        headers: signed.headers,
        method: input.method,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (!response.ok) {
        const error = new Error(
          `OpenSearch request failed with status ${response.status}.`,
        ) as Error & { details: unknown; status: number };
        error.details = parsed;
        error.status = response.status;
        throw error;
      }
      return parsed;
    },
  };
}
