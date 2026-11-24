import { afterEach, describe, expect, it } from "bun:test";
import { createPlatformSdk } from "./index.ts";

const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function platformApi({
  storageStatus,
  uploadUrl,
}: {
  readonly storageStatus: number;
  readonly uploadUrl: (origin: string) => string;
}) {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      received.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/v1/artifacts") {
        return Response.json({
          artifact: { artifactId: "artifact_1", status: "pending" },
          upload: {
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            headers: { "content-type": "image/png" },
            method: "PUT",
            url: uploadUrl(url.origin),
          },
        });
      }
      if (url.pathname === "/storage/artifact_1") {
        return new Response("<Error><Code>AccessDenied</Code></Error>", {
          headers: { "x-amz-request-id": "storage-request-1" },
          status: storageStatus,
        });
      }
      return Response.json({ artifactId: "artifact_1", status: "available" });
    },
  });
  servers.push(server);
  return {
    received,
    artifacts: createPlatformSdk({
      apiKey: "platform-api-key",
      baseUrl: server.url.toString(),
    }).runtime({}).artifacts,
  };
}

const image = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  contentType: "image/png",
  fileName: "a.png",
  name: "a.png",
  type: "input",
};

describe("runtime artifacts.uploadBytes", () => {
  it("refuses a plain-HTTP storage URL off loopback before sending the bytes", async () => {
    const api = platformApi({
      storageStatus: 200,
      uploadUrl: () => "http://storage.example.test/artifact_1?X-Amz-Signature=signature",
    });

    const failure = await api.artifacts.uploadBytes(image).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: "Artifact uploads require HTTPS unless the storage host is loopback.",
      name: "PlatformRequestError",
    });
  });

  it("does not complete an upload whose bytes storage rejected", async () => {
    const api = platformApi({
      storageStatus: 403,
      uploadUrl: (origin) => `${origin}/storage/artifact_1`,
    });

    const failure = await api.artifacts.uploadBytes(image).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "PlatformApiError",
      problem: {
        requestId: "storage-request-1",
        status: 403,
        title: "Artifact storage rejected the upload.",
      },
    });
    expect(api.received).toEqual(["POST /v1/artifacts", "PUT /storage/artifact_1"]);
  });
});
