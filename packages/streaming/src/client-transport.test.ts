import { describe, expect, it } from "bun:test";
import {
  createDurableStreamsClientTransport,
  StreamContractError,
  threadStreamPath,
  type ThreadStreamScope,
} from "./index.ts";

const scope: ThreadStreamScope = {
  environmentId: "environment-1",
  organizationId: "organization-1",
  projectId: "project-1",
  threadId: "thread-1",
};
const streamPath = threadStreamPath(scope);

async function requestBodyText(body: RequestInit["body"]): Promise<string> {
  return body === undefined || body === null ? "" : new Response(body).text();
}

function mockFetch(
  handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return handler as unknown as typeof globalThis.fetch;
}

describe("Durable Streams client transport", () => {
  it("creates a stream and appends JSON entries with an idempotent producer", async () => {
    const requests: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fetch = mockFetch(async (url, init) => {
      requests.push({
        ...(init ? { init } : {}),
        url: url instanceof Request ? url.url : url.toString(),
      });
      if (init?.method === "PUT") {
        return new Response(null, { status: 201 });
      }
      return new Response(null, {
        headers: { "Stream-Next-Offset": "2_0" },
        status: 200,
      });
    });
    const transport = createDurableStreamsClientTransport({
      authToken: "stream-token",
      baseUrl: "https://streams.example.test/root/",
      fetch,
      lingerMs: 0,
      producerHeaders: { "x-producer-scope": "thread" },
      ttlSeconds: 86_400,
    });

    const result = await transport.append({
      entries: ['{"eventId":"event-1"}', '{"eventId":"event-2"}'],
      producerId: "worker:worker-1",
      streamPath,
    });

    expect(result).toEqual({ lastSuccessfulOffset: "2_0" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`https://streams.example.test/root${streamPath}`);
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer stream-token",
    );
    expect(new Headers(requests[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(requests[0]?.init?.headers).get("stream-ttl")).toBe("86400");
    expect(requests[1]?.init?.method).toBe("POST");
    expect(new Headers(requests[1]?.init?.headers).get("producer-id")).toMatch(
      /^batch:[0-9a-f]{32}$/u,
    );
    expect(new Headers(requests[1]?.init?.headers).get("producer-epoch")).toBe("0");
    expect(new Headers(requests[1]?.init?.headers).get("producer-seq")).toBe("0");
    expect(new Headers(requests[1]?.init?.headers).get("x-producer-scope")).toBe("thread");
    expect(JSON.parse(await requestBodyText(requests[1]?.init?.body))).toEqual([
      { eventId: "event-1" },
      { eventId: "event-2" },
    ]);
  });

  it("continues appending when create confirms a matching existing stream", async () => {
    const methods: string[] = [];
    const fetch = mockFetch(async (_url, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "PUT") return new Response(null, { status: 200 });
      return new Response(null, {
        headers: { "Stream-Next-Offset": "3_0" },
        status: 200,
      });
    });
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch,
      lingerMs: 0,
    });

    expect(
      transport.append({ entries: ["{}"], producerId: "api:event-1", streamPath }),
    ).resolves.toEqual({ lastSuccessfulOffset: "3_0" });
    expect(methods).toEqual(["PUT", "POST"]);
  });

  it("rejects an existing stream with conflicting configuration", async () => {
    const methods: string[] = [];
    const fetch = mockFetch(async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, { status: 409 });
    });
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch,
      lingerMs: 0,
      ttlSeconds: 86_400,
    });

    expect(
      transport.append({ entries: ["{}"], producerId: "api:event-1", streamPath }),
    ).rejects.toMatchObject({ status: 409 });
    expect(methods).toEqual(["PUT"]);
  });

  it("can append to a provisioned stream without issuing a create request", async () => {
    const methods: string[] = [];
    const fetch = mockFetch(async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, {
        headers: { "Stream-Next-Offset": "4_0" },
        status: 200,
      });
    });
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      createIfMissing: false,
      fetch,
      lingerMs: 0,
    });

    await transport.append({ entries: ["{}"], producerId: "worker:worker-1", streamPath });

    expect(methods).toEqual(["POST"]);
  });

  it("forwards an append abort signal to the in-flight producer request", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      createIfMissing: false,
      fetch: mockFetch(async (_url, init) => {
        requestSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const rejectAbort = () => reject(signal.reason);
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
      }),
      lingerMs: 0,
    });

    const append = transport.append({
      entries: ['{"eventId":"event-1"}'],
      producerId: "worker:worker-1",
      signal: controller.signal,
      streamPath,
    });
    await Bun.sleep(0);
    controller.abort(new Error("progress append deadline exceeded"));

    expect(append).rejects.toThrow("progress append deadline exceeded");
    expect(requestSignal).toBe(controller.signal);
  });

  it("uses one deterministic producer sequence identity per independently retried batch", async () => {
    const producerIds: string[] = [];
    const fetch = mockFetch(async (_url, init) => {
      producerIds.push(new Headers(init?.headers).get("producer-id") ?? "");
      return new Response(null, {
        headers: { "Stream-Next-Offset": `${producerIds.length}_0` },
        status: producerIds.length === 3 ? 204 : 200,
      });
    });
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      createIfMissing: false,
      fetch,
      lingerMs: 0,
    });

    await transport.append({
      entries: ['{"eventId":"event-1"}'],
      producerId: "worker:worker-1",
      streamPath,
    });
    await transport.append({
      entries: ['{"eventId":"event-2"}'],
      producerId: "worker:replacement-worker",
      streamPath,
    });
    await transport.append({
      entries: ['{"eventId":"event-2"}'],
      producerId: "worker:worker-1",
      streamPath,
    });

    expect(producerIds[0]).not.toBe(producerIds[1]);
    expect(producerIds[1]).toBe(producerIds[2]);
  });

  it("rejects conflicting stream retention settings before network I/O", () => {
    expect(() =>
      createDurableStreamsClientTransport({
        baseUrl: "https://streams.example.test",
        expiresAt: "2026-07-23T00:00:00.000Z",
        ttlSeconds: 86_400,
      }),
    ).toThrow("mutually exclusive");
  });

  it("rejects append payloads that would split opaque offsets across producer batches", async () => {
    let requested = false;
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch: mockFetch(async () => {
        requested = true;
        return new Response(null, { status: 200 });
      }),
      maxBatchBytes: 4,
    });

    expect(
      transport.append({
        entries: ['{"eventId":"too-large"}'],
        producerId: "worker:worker-1",
        streamPath,
      }),
    ).rejects.toThrow("single-batch limit");
    expect(requested).toBe(false);
  });

  it("includes JSON array framing in the single-batch byte limit", async () => {
    let requested = false;
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch: mockFetch(async () => {
        requested = true;
        return new Response(null, { status: 200 });
      }),
      maxBatchBytes: 6,
    });

    expect(
      transport.append({
        entries: ["{}", "{}"],
        producerId: "worker:worker-1",
        streamPath,
      }),
    ).rejects.toThrow("single-batch limit");
    expect(requested).toBe(false);
  });

  it("reads the current opaque stream offset with HEAD", async () => {
    const requests: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fetch = mockFetch(async (url, init) => {
      requests.push({
        ...(init ? { init } : {}),
        url: url instanceof Request ? url.url : url.toString(),
      });
      return new Response(null, {
        headers: { "Stream-Next-Offset": "offset/+opaque==" },
        status: 200,
      });
    });
    const transport = createDurableStreamsClientTransport({
      authHeaderName: "X-Durable-Streams-Key",
      authToken: "internal-token",
      baseUrl: "https://streams.example.test",
      fetch,
    });

    expect(transport.currentOffset(streamPath)).resolves.toBe("offset/+opaque==");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe("HEAD");
    expect(new Headers(requests[0]?.init?.headers).get("x-durable-streams-key")).toBe(
      "internal-token",
    );
  });

  it("creates a missing stream before reading its current offset", async () => {
    const methods: string[] = [];
    const transport = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch: mockFetch(async (_url, init) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "PUT") return new Response(null, { status: 201 });
        if (methods.length === 1) return new Response(null, { status: 404 });
        return new Response(null, {
          headers: { "Stream-Next-Offset": "0_0" },
          status: 200,
        });
      }),
    });

    expect(transport.currentOffset(streamPath)).resolves.toBe("0_0");
    expect(methods).toEqual(["HEAD", "PUT", "HEAD"]);
  });

  it("fails closed for missing provisioned streams, missing offsets, and upstream errors", async () => {
    const missing = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      createIfMissing: false,
      fetch: mockFetch(async () => new Response(null, { status: 404 })),
    });
    expect(missing.currentOffset(streamPath)).rejects.toBeInstanceOf(StreamContractError);

    const missingOffset = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      fetch: mockFetch(async () => new Response(null, { status: 200 })),
    });
    expect(missingOffset.currentOffset(streamPath)).rejects.toThrow("omitted its offset");

    const denied = createDurableStreamsClientTransport({
      baseUrl: "https://streams.example.test",
      createIfMissing: false,
      fetch: mockFetch(async () => new Response("denied", { status: 401 })),
      lingerMs: 0,
    });
    expect(
      denied.append({ entries: ["{}"], producerId: "worker:worker-1", streamPath }),
    ).rejects.toMatchObject({ name: "FetchError", status: 401 });
  });
});
