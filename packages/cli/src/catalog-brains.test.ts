import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatformSdk } from "@agentifiers/deployments-sdk";
import { buildRequest } from "./command-runtime.ts";
import { brainCommandCatalog } from "./catalog-brains.ts";
import type { ResolvedCliContext } from "./types.ts";

const directories: string[] = [];
const context: ResolvedCliContext = {
  apiKey: "token",
  apiUrl: "https://api.example.com",
  environmentId: "environment-1",
  mock: false,
  organizationId: "organization-1",
  profileName: "default",
  projectId: "project-1",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Brain CLI catalog", () => {
  test("serializes an explicit Brain set into search request JSON", async () => {
    const request = await buildRequest(
      brainCommandCatalog.brain!.actions.search!,
      { brains: "brain-1,brain-2", limit: "5", query: "Why?" },
      context,
      {},
    );
    expect(request).toMatchObject({
      body: { brainIds: ["brain-1", "brain-2"], limit: 5, query: "Why?" },
      context: {
        environmentId: "environment-1",
        organizationId: "organization-1",
        projectId: "project-1",
      },
      path: "/v1/brains/search",
    });
    expect(brainCommandCatalog.brain!.actions.search!.scope).toBe("tenant");
    expect(brainCommandCatalog.brain!.actions.ask!.scope).toBe("tenant");
  });

  test("streams exact binary upload bytes with the declared content type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brain-cli-"));
    directories.push(directory);
    const path = join(directory, "evidence.bin");
    await writeFile(path, new Uint8Array([0, 1, 2, 255]));
    const request = await buildRequest(
      brainCommandCatalog["brain-upload"]!.actions.content!,
      {
        brain: "brain-1",
        "content-type": "application/pdf",
        file: path,
        source: "source-1",
        ticket: "ticket-1",
      },
      context,
      {},
    );
    expect(request.path).toBe("/v1/brains/brain-1/sources/source-1/uploads/ticket-1/content");
    expect(request.contentType).toBe("application/pdf");
    expect([...request.rawBody!]).toEqual([0, 1, 2, 255]);
    expect(request.body).toBeUndefined();
  });

  test("uploads an 8 MiB file through the ticket's direct upload and completes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brain-cli-"));
    directories.push(directory);
    const path = join(directory, "evidence.pdf");
    await writeFile(path, new Uint8Array(8 * 1024 * 1024));
    const ticketPath = "/v1/brains/brain-1/sources/source-1/uploads/ticket-1";
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(incoming) {
        const url = new URL(incoming.url);
        received.push(
          `${incoming.method} ${url.pathname} ${(await incoming.arrayBuffer()).byteLength}`,
        );
        if (url.pathname === "/storage/ticket-1") return new Response(null, { status: 200 });
        return Response.json(
          incoming.method === "GET"
            ? {
                directUpload: {
                  completePath: `${ticketPath}/complete`,
                  expiresAt: "2026-07-30T12:05:00.000Z",
                  headers: { "content-type": "application/pdf" },
                  method: "PUT",
                  url: `${url.origin}/storage/ticket-1`,
                },
                id: "ticket-1",
                mediaType: "application/pdf",
                status: "issued",
                uploadPath: `${ticketPath}/content`,
              }
            : { id: "ticket-1", status: "completed" },
        );
      },
    });
    const spec = brainCommandCatalog["brain-upload"]!.actions.content!;
    const request = await buildRequest(
      spec,
      {
        brain: "brain-1",
        "content-type": "application/pdf",
        file: path,
        source: "source-1",
        ticket: "ticket-1",
      },
      context,
      {},
    );

    const response = await spec.send!(
      createPlatformSdk({ apiKey: "token", baseUrl: server.url.toString() }),
      request,
    ).finally(() => server.stop(true));

    expect(response.data).toEqual({ id: "ticket-1", status: "completed" });
    expect(received).toEqual([
      `GET ${ticketPath} 0`,
      "PUT /storage/ticket-1 8388608",
      `POST ${ticketPath}/complete 0`,
    ]);
  });
});
