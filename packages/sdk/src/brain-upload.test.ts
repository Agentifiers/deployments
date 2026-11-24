import { afterEach, describe, expect, it } from "bun:test";
import type { BrainUploadTicketResponse } from "@deployments-ai/api-contract/brains";
import { createPlatformSdk, uploadBrainContent } from "./index.ts";

const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

const TICKET_PATH = "/v1/brains/brain_1/sources/source_1/uploads/ticket_1";

function ticket(origin: string, status: BrainUploadTicketResponse["status"]) {
  return {
    brainId: "brain_1",
    createdAt: "2026-07-30T12:00:00.000Z",
    expectedByteSize: 8 * 1024 * 1024,
    expectedContentHash: `sha256:${"ab".repeat(32)}`,
    expiresAt: "2026-07-30T12:05:00.000Z",
    id: "ticket_1",
    mediaType: "application/pdf",
    organizationId: "org_1",
    sourceId: "source_1",
    status,
    updatedAt: "2026-07-30T12:00:00.000Z",
    version: status === "issued" ? 0 : 2,
    ...(status === "issued"
      ? {
          directUpload: {
            completePath: `${TICKET_PATH}/complete`,
            expiresAt: "2026-07-30T12:05:00.000Z",
            headers: { "content-type": "application/pdf", "if-none-match": "*" },
            method: "PUT" as const,
            url: `${origin}/storage/ticket_1?X-Amz-Signature=signature`,
          },
          uploadPath: `${TICKET_PATH}/content`,
        }
      : {}),
  };
}

const FETCH_RUNTIME_HEADERS: Record<string, true> = {
  accept: true,
  "accept-encoding": true,
  connection: true,
  host: true,
  "user-agent": true,
};

const bearerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer x");
  return fetch(input, { ...init, headers });
}) as typeof fetch;

function platform(storageStatus: number, storageFetch?: typeof fetch) {
  const received: string[] = [];
  const storageHeaders: [string, string][][] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const bytes = (await request.arrayBuffer()).byteLength;
      received.push(
        `${request.method} ${url.pathname} bytes=${bytes} authorization=${request.headers.get("authorization") ?? "none"} idempotency-key=${request.headers.get("idempotency-key") ?? "none"}`,
      );
      if (url.pathname === "/storage/ticket_1") {
        storageHeaders.push([...request.headers].filter(([name]) => !FETCH_RUNTIME_HEADERS[name]));
        return new Response(null, { status: storageStatus });
      }
      return Response.json(ticket(url.origin, "completed"));
    },
  });
  servers.push(server);
  return {
    issued: ticket(server.url.origin, "issued"),
    received,
    sdk: createPlatformSdk({
      baseUrl: server.url.toString(),
      fetch: bearerFetch,
      ...(storageFetch ? { storageFetch } : {}),
    }),
    storageHeaders,
  };
}

describe("uploadBrainContent", () => {
  it.each([200, 412])(
    "sends an 8 MiB file to storage and completes the ticket when storage answers %d",
    async (storageStatus) => {
      const { issued, received, sdk } = platform(storageStatus);

      const completed = await uploadBrainContent(sdk, {
        bytes: new Uint8Array(8 * 1024 * 1024),
        context: { organizationId: "org_1" },
        idempotencyKey: "upload-1",
        ticket: issued,
      });

      expect(completed.data.status).toBe("completed");
      expect(received).toEqual([
        "PUT /storage/ticket_1 bytes=8388608 authorization=none idempotency-key=none",
        `POST ${TICKET_PATH}/complete bytes=0 authorization=Bearer x idempotency-key=upload-1`,
      ]);
    },
  );

  it("does not complete a ticket whose bytes storage refused", async () => {
    const { issued, received, sdk } = platform(403);

    const failure = await uploadBrainContent(sdk, {
      bytes: new Uint8Array(3),
      context: { organizationId: "org_1" },
      idempotencyKey: "upload-1",
      ticket: issued,
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(failure).toBe("Artifact storage rejected the upload.");
    expect(received).toEqual([
      "PUT /storage/ticket_1 bytes=3 authorization=none idempotency-key=none",
    ]);
  });

  it("sends storage exactly the signed headers although the SDK's fetch adds a bearer", async () => {
    const { issued, received, sdk, storageHeaders } = platform(200);

    await uploadBrainContent(sdk, {
      bytes: new Uint8Array(3),
      context: { organizationId: "org_1" },
      idempotencyKey: "upload-1",
      ticket: issued,
    });

    expect(storageHeaders).toEqual([
      [
        ["content-length", "3"],
        ["content-type", "application/pdf"],
        ["if-none-match", "*"],
      ],
    ]);
    expect(received).toEqual([
      "PUT /storage/ticket_1 bytes=3 authorization=none idempotency-key=none",
      `POST ${TICKET_PATH}/complete bytes=0 authorization=Bearer x idempotency-key=upload-1`,
    ]);
  });

  it("sends the presigned PUT through the storage fetch the caller passes", async () => {
    const sent: string[] = [];
    const { issued, received, sdk } = platform(200, (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push(`${init?.method} ${JSON.stringify(init?.headers)}`);
      return fetch(input, init);
    }) as typeof fetch);

    await uploadBrainContent(sdk, {
      bytes: new Uint8Array(3),
      context: { organizationId: "org_1" },
      idempotencyKey: "upload-1",
      ticket: issued,
    });

    expect(sent).toEqual(['PUT {"content-type":"application/pdf","if-none-match":"*"}']);
    expect(received).toEqual([
      "PUT /storage/ticket_1 bytes=3 authorization=none idempotency-key=none",
      `POST ${TICKET_PATH}/complete bytes=0 authorization=Bearer x idempotency-key=upload-1`,
    ]);
  });
});
