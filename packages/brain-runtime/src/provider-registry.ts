import {
  makeAwsNativeBrainSearchProvider,
  type BrainOpenSearchTransport,
  type BrainSearchProviderClient,
  type BrainSearchProviderRegistry,
  type BrainSearchTarget,
} from "@deployments-ai/brains";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { DynamoDatabaseService, Ulid } from "@deployments-ai/db";
import { SignatureV4 } from "@smithy/signature-v4";
import { createHash, createHmac } from "node:crypto";
import { loadBrainEmbeddingProfile } from "./embedding.ts";

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

function text(location: Readonly<Record<string, unknown>>, field: string) {
  const value = location[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Brain search target location requires ${field}.`);
  }
  return value.trim();
}

// Deployment IAM scopes Brain runtimes to this index prefix so Brain and Memory
// can share one OpenSearch domain without reaching each other's indexes.
const BRAIN_OPEN_SEARCH_INDEX_PREFIX = "brain-";

function brainIndex(location: Readonly<Record<string, unknown>>) {
  const index = text(location, "openSearchIndex");
  if (!index.startsWith(BRAIN_OPEN_SEARCH_INDEX_PREFIX)) {
    throw new TypeError(
      `Brain search target index must start with ${BRAIN_OPEN_SEARCH_INDEX_PREFIX}.`,
    );
  }
  return index;
}

/** Signs requests to a Brain OpenSearch endpoint, which must be the approved Brain domain. */
export function brainOpenSearchTransport(input: {
  readonly approvedEndpoint: string;
  readonly endpoint: string;
  readonly region: string;
}): BrainOpenSearchTransport {
  const endpoint = new URL(input.endpoint);
  const approved = new URL(input.approvedEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== approved.origin ||
    endpoint.pathname !== "/"
  ) {
    throw new TypeError("Brain OpenSearch target is not the approved Brain domain.");
  }
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: input.region,
    service: "es",
    sha256: NodeSha256,
  });
  return {
    async request(request) {
      const url = new URL(request.path, endpoint);
      if (url.origin !== endpoint.origin) {
        throw new TypeError("Brain OpenSearch request escaped its approved domain.");
      }
      const body =
        request.body === undefined
          ? undefined
          : typeof request.body === "string"
            ? request.body
            : JSON.stringify(request.body);
      const signed = await signer.sign({
        ...(body === undefined ? {} : { body }),
        headers: {
          host: url.host,
          ...(body === undefined
            ? {}
            : { "content-type": request.contentType ?? "application/json" }),
        },
        hostname: url.hostname,
        method: request.method,
        path: url.pathname,
        ...(url.port ? { port: Number(url.port) } : {}),
        protocol: url.protocol,
        query: Object.fromEntries(url.searchParams),
      });
      const response = await fetch(url, {
        ...(body === undefined ? {} : { body }),
        headers: signed.headers,
        method: request.method,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const responseText = await response.text();
      const parsed = responseText ? (JSON.parse(responseText) as unknown) : {};
      if (!response.ok) {
        const error =
          parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
        throw Object.assign(
          new Error(`Brain OpenSearch request failed with status ${response.status}.`),
          {
            status: response.status,
            type: error && typeof error === "object" && "type" in error ? error.type : undefined,
          },
        );
      }
      return parsed;
    },
  };
}

function identity(target: BrainSearchTarget) {
  return JSON.stringify({
    embeddingProfileId: target.embeddingProfileId,
    location: target.location,
    providerId: target.providerId,
    schemaGeneration: target.schemaGeneration,
    targetId: target.targetId,
  });
}

export interface BrainSearchProviderRuntimeConfig {
  readonly aws?: {
    readonly openSearchEndpoint: string;
  };
}

export function makeBrainSearchProviderRegistry(input: {
  readonly config: BrainSearchProviderRuntimeConfig;
  readonly database: DynamoDatabaseService;
}): BrainSearchProviderRegistry {
  const cache = new Map<string, Promise<BrainSearchProviderClient>>();
  const targetIdentities = new Map<string, string>();
  return {
    resolve(target) {
      if (!target.embeddingProfileId) {
        throw new TypeError("Brain search target has no immutable embedding profile.");
      }
      const targetIdentity = identity(target);
      const existingIdentity = targetIdentities.get(target.targetId);
      if (existingIdentity && existingIdentity !== targetIdentity) {
        throw new TypeError("Brain search target identity changed without a new target ID.");
      }
      const existing = cache.get(targetIdentity);
      if (existing) return existing;
      targetIdentities.set(target.targetId, targetIdentity);
      const pending = (async () => {
        const profile = await loadBrainEmbeddingProfile(
          input.database,
          target.embeddingProfileId as Ulid,
        );
        if (!input.config.aws) throw new Error("AWS-native Brain search is not configured.");
        const location = target.location;
        return makeAwsNativeBrainSearchProvider({
          config: {
            embeddingDimensions: profile.data.dimensions,
            openSearchIndex: brainIndex(location),
          },
          openSearch: brainOpenSearchTransport({
            approvedEndpoint: input.config.aws.openSearchEndpoint,
            endpoint: text(location, "openSearchEndpoint"),
            region: text(location, "region"),
          }),
          target,
        });
      })();
      cache.set(targetIdentity, pending);
      pending.catch(() => {
        if (cache.get(targetIdentity) === pending) cache.delete(targetIdentity);
        if (targetIdentities.get(target.targetId) === targetIdentity) {
          targetIdentities.delete(target.targetId);
        }
      });
      return pending;
    },
  };
}
