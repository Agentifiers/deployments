import {
  DurableStream,
  IdempotentProducer,
  type IdempotentProducerOptions,
} from "@durable-streams/client";
import { StreamContractError } from "./errors.ts";
import {
  DURABLE_STREAM_CONTENT_TYPE,
  durableStreamHeaders,
  durableStreamUrl,
  type DurableStreamAppendInput,
  type DurableStreamAppendResult,
  type DurableStreamServerConfig,
  type DurableStreamTransport,
} from "./transport.ts";

export interface DurableStreamsClientTransportOptions extends DurableStreamServerConfig {
  readonly createIfMissing?: boolean;
  readonly expiresAt?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly lingerMs?: number;
  readonly maxBatchBytes?: number;
  readonly maxInFlight?: number;
  readonly producerHeaders?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly ttlSeconds?: number;
}

export const DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES = 1024 * 1024;
export const DEFAULT_DURABLE_STREAM_TTL_SECONDS = 30 * 24 * 60 * 60;

async function appendProducerId(input: DurableStreamAppendInput): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([input.streamPath, input.entries] as const)),
  );
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `batch:${suffix}`;
}

function streamHandleOptions(options: DurableStreamsClientTransportOptions, streamPath: string) {
  return {
    contentType: DURABLE_STREAM_CONTENT_TYPE,
    headers: { ...durableStreamHeaders(options) },
    url: durableStreamUrl({
      ...(options.allowInsecurePrivateHttp ? { allowInsecurePrivateHttp: true } : {}),
      baseUrl: options.baseUrl,
      streamPath,
    }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

async function createStreamIfMissing(
  options: DurableStreamsClientTransportOptions,
  streamPath: string,
): Promise<DurableStream> {
  const handleOptions = streamHandleOptions(options, streamPath);
  return DurableStream.create({
    ...handleOptions,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
  });
}

function producerOptions(
  options: DurableStreamsClientTransportOptions,
  onError: (error: Error) => void,
): IdempotentProducerOptions {
  return {
    autoClaim: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.lingerMs !== undefined ? { lingerMs: options.lingerMs } : {}),
    ...(options.maxBatchBytes !== undefined ? { maxBatchBytes: options.maxBatchBytes } : {}),
    ...(options.maxInFlight !== undefined ? { maxInFlight: options.maxInFlight } : {}),
    ...(options.producerHeaders ? { headers: { ...options.producerHeaders } } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onError,
  };
}

export class DurableStreamsClientTransport implements DurableStreamTransport {
  readonly #options: DurableStreamsClientTransportOptions;

  constructor(options: DurableStreamsClientTransportOptions) {
    if (options.expiresAt !== undefined && options.ttlSeconds !== undefined) {
      throw new StreamContractError(
        "retention",
        "Durable Streams expiresAt and ttlSeconds are mutually exclusive.",
      );
    }
    if (
      options.maxBatchBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBatchBytes) || options.maxBatchBytes <= 0)
    ) {
      throw new StreamContractError(
        "maxBatchBytes",
        "Durable Streams maxBatchBytes must be a positive integer.",
      );
    }
    this.#options = {
      ...options,
      ...(options.extraHeaders ? { extraHeaders: { ...options.extraHeaders } } : {}),
      ...(options.producerHeaders ? { producerHeaders: { ...options.producerHeaders } } : {}),
    };
  }

  async append(input: DurableStreamAppendInput): Promise<DurableStreamAppendResult> {
    if (input.producerId.length === 0) {
      throw new StreamContractError("producerId", "Durable Streams producerId is required.");
    }
    if (input.entries.length === 0) return {};
    const options = input.signal ? { ...this.#options, signal: input.signal } : this.#options;
    const maximumBatchBytes =
      options.maxBatchBytes ?? DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES;
    const appendBytes = new TextEncoder().encode(`[${input.entries.join(",")}]`).byteLength;
    if (appendBytes > maximumBatchBytes) {
      throw new StreamContractError(
        "entries",
        `Durable Streams append payload exceeds the single-batch limit of ${maximumBatchBytes} bytes.`,
      );
    }
    const handle =
      (options.createIfMissing ?? true)
        ? await createStreamIfMissing(options, input.streamPath)
        : new DurableStream(streamHandleOptions(options, input.streamPath));
    let producerError: Error | undefined;
    const producer = new IdempotentProducer(
      handle,
      await appendProducerId(input),
      producerOptions(options, (error) => {
        producerError ??= error;
      }),
    );
    try {
      for (const entry of input.entries) producer.append(entry);
      await producer.flush();
      if (producerError) throw producerError;
      return producer.lastSuccessfulOffset
        ? { lastSuccessfulOffset: producer.lastSuccessfulOffset }
        : {};
    } finally {
      await producer.detach();
    }
  }

  async currentOffset(streamPath: string): Promise<string> {
    const handleOptions = streamHandleOptions(this.#options, streamPath);
    let head = await DurableStream.head(handleOptions);
    if (!head.exists && (this.#options.createIfMissing ?? true)) {
      await createStreamIfMissing(this.#options, streamPath);
      head = await DurableStream.head(handleOptions);
    }
    if (!head.exists) {
      throw new StreamContractError("streamPath", "Durable Stream does not exist.");
    }
    if (head.offset === undefined || head.offset.length === 0) {
      throw new StreamContractError("offset", "Durable Stream HEAD response omitted its offset.");
    }
    return head.offset;
  }
}

export function createDurableStreamsClientTransport(
  options: DurableStreamsClientTransportOptions,
): DurableStreamTransport {
  return new DurableStreamsClientTransport(options);
}
