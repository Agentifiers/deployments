import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { s3RegistryStore } from "./s3-store.ts";

interface CapturedRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
}

interface LocalResponse {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

function localS3(respond: (request: CapturedRequest) => LocalResponse) {
  const requests: CapturedRequest[] = [];
  const client = new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
    region: "us-east-2",
    requestHandler: {
      async handle(request: CapturedRequest) {
        const captured = {
          body: request.body,
          headers: request.headers,
          method: request.method,
          path: request.path,
          query: request.query,
        };
        requests.push(captured);
        const response = respond(captured);
        return {
          response: {
            body: Readable.from([Buffer.from(response.body ?? "")]),
            headers: response.headers ?? {},
            statusCode: response.statusCode,
          },
        };
      },
    },
  });
  return {
    requests,
    store: s3RegistryStore({ bucket: "platform-releases", client, retryDelayMs: 0 }),
  };
}

async function bundleFile(bytes: Uint8Array) {
  const path = join(await mkdtemp(join(tmpdir(), "s3-store-")), "console.zip");
  await writeFile(path, bytes);
  return {
    body: { kind: "file", path, sizeBytes: bytes.byteLength } as const,
    key: "releases/abc/console.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tags: {},
  };
}

async function connectionDroppingS3(dropAfterBytes: number, droppedAttempts = 1) {
  const uploads: Buffer[][] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    const attempt = uploads.push(chunks);
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (attempt <= droppedAttempts && received >= dropAfterBytes) request.socket.destroy();
    });
    request.on("end", () => response.writeHead(200).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    forcePathStyle: true,
    region: "us-east-2",
  });
  return {
    server,
    store: s3RegistryStore({ bucket: "platform-releases", client, retryDelayMs: 0 }),
    uploads: () => uploads.map((chunks) => Buffer.concat(chunks)),
  };
}

const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const sha256Base64 = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";

describe("S3 registry store", () => {
  test("writes create-only with the SHA-256 checksum and publish tags", async () => {
    const { requests, store } = localS3(() => ({ statusCode: 200 }));
    const outcome = await store.putObject({
      body: { bytes: new TextEncoder().encode("hello"), kind: "bytes" },
      key: "releases/abc/release.json",
      sha256,
      tags: { object: "payload", retention: "dev" },
    });
    expect(outcome).toBe("created");
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.path).toBe("/platform-releases/releases/abc/release.json");
    expect(requests[0]?.headers).toMatchObject({
      "content-length": "5",
      "if-none-match": "*",
      "x-amz-checksum-sha256": sha256Base64,
      "x-amz-sdk-checksum-algorithm": "SHA256",
      "x-amz-tagging": "object=payload&retention=dev",
    });
  });

  test("reports an existing key on 412 and surfaces a concurrent write on 409", async () => {
    const put = (statusCode: number, code: string) =>
      localS3(() => ({ body: `<Error><Code>${code}</Code></Error>`, statusCode })).store.putObject({
        body: { bytes: new TextEncoder().encode("hello"), kind: "bytes" },
        key: "releases/abc/release.json",
        sha256,
        tags: {},
      });
    expect(await put(412, "PreconditionFailed")).toBe("exists");
    expect(put(409, "ConditionalRequestConflict")).rejects.toThrow(
      "Another publish is writing releases/abc/release.json; rerun the publish.",
    );
  });

  test("reads the stored full-object checksum as hex and a missing key as absent", async () => {
    const { store } = localS3((request) =>
      request.path.endsWith("/present")
        ? {
            headers: { "content-length": "5", "x-amz-checksum-sha256": sha256Base64 },
            statusCode: 200,
          }
        : { statusCode: 404 },
    );
    expect(await store.headObject("present")).toEqual({ sha256, sizeBytes: 5 });
    expect(await store.headObject("absent")).toBeUndefined();
  });

  test("follows continuation tokens when listing release names", async () => {
    const { requests, store } = localS3((request) => ({
      body:
        request.query["continuation-token"] === undefined
          ? "<ListBucketResult><CommonPrefixes><Prefix>releases/a/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken></ListBucketResult>"
          : "<ListBucketResult><CommonPrefixes><Prefix>releases/b/</Prefix></CommonPrefixes><IsTruncated>false</IsTruncated></ListBucketResult>",
      statusCode: 200,
    }));
    expect(await store.listChildNames("releases/")).toEqual(["a", "b"]);
    expect(requests.map(({ query }) => [query.delimiter, query.prefix])).toEqual([
      ["/", "releases/"],
      ["/", "releases/"],
    ]);
  });

  test("re-sends a bundle file from the start after the connection drops mid-upload", async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(7);
    const object = await bundleFile(bytes);
    const { server, store, uploads } = await connectionDroppingS3(1024 * 1024);
    try {
      expect(await store.putObject(object)).toBe("created");
      const uploadedSha256 = uploads().map((upload) =>
        createHash("sha256").update(upload).digest("hex"),
      );
      expect(uploadedSha256.map((digest) => digest === object.sha256)).toEqual([false, true]);
    } finally {
      server.close();
    }
  });

  test("names the bundle file and keeps the network error when every attempt drops", async () => {
    const object = await bundleFile(new Uint8Array(4 * 1024 * 1024).fill(7));
    const { server, store, uploads } = await connectionDroppingS3(1024 * 1024, 4);
    try {
      const failure = await store.putObject(object).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("releases/abc/console.zip");
      // The server resets the socket mid-body; the client sees ECONNRESET or, while still writing, EPIPE.
      expect(["ECONNRESET", "EPIPE"]).toContain(
        String(((failure as Error).cause as { code?: unknown }).code),
      );
      expect(uploads().length).toBe(4);
    } finally {
      server.close();
    }
  });

  test("retries a bundle file on S3 5xx and timeouts and resolves a landed retry by its 412", async () => {
    const statuses = [
      { code: "InternalError", statusCode: 500 },
      { code: "SlowDown", statusCode: 503 },
      { code: "RequestTimeout", statusCode: 400 },
      { code: "PreconditionFailed", statusCode: 412 },
    ];
    const { requests, store } = localS3(() => {
      const { code, statusCode } = statuses[requests.length - 1]!;
      return { body: `<Error><Code>${code}</Code></Error>`, statusCode };
    });
    expect(await store.putObject(await bundleFile(new TextEncoder().encode("hello")))).toBe(
      "exists",
    );
    expect(requests.map(({ headers }) => headers["if-none-match"])).toEqual(["*", "*", "*", "*"]);
  });

  test("retries a 409 conflict until the write that won answers 412", async () => {
    const statuses = [
      { code: "ConditionalRequestConflict", statusCode: 409 },
      { code: "PreconditionFailed", statusCode: 412 },
    ];
    const { requests, store } = localS3(() => {
      const { code, statusCode } = statuses[requests.length - 1]!;
      return { body: `<Error><Code>${code}</Code></Error>`, statusCode };
    });
    expect(await store.putObject(await bundleFile(new TextEncoder().encode("hello")))).toBe(
      "exists",
    );
    expect(requests.length).toBe(2);
  });

  test("does not retry a bundle file rejected with a client error", async () => {
    const { requests, store } = localS3(() => ({
      body: "<Error><Code>AccessDenied</Code></Error>",
      statusCode: 403,
    }));
    const object = await bundleFile(new TextEncoder().encode("hello"));
    expect(store.putObject(object)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    expect(requests.length).toBe(1);
  });

  test("gives up on a bundle file after four failed attempts and closes every stream", async () => {
    const { requests, store } = localS3(() => ({
      body: "<Error><Code>InternalError</Code></Error>",
      statusCode: 500,
    }));
    const object = await bundleFile(new TextEncoder().encode("hello"));
    const failure = await store.putObject(object).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("releases/abc/console.zip");
    expect((failure as Error).cause).toMatchObject({
      $metadata: { httpStatusCode: 500 },
      name: "InternalError",
    });
    expect(requests.map(({ body }) => (body as ReadStream).destroyed)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
