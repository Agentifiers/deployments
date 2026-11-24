import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CSV = new TextEncoder().encode("region,revenue\nNorth,120\nSouth,95\n");
const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SPAWN_TIMEOUT_MS = 30_000;

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "deployments-chat-"));
  directories.push(directory);
  return directory;
}

function json(request: ReceivedRequest | undefined): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request?.body));
}

function routes(received: readonly ReceivedRequest[]) {
  return received.map(({ method, path }) => `${method} ${path}`);
}

function fakePlatformApiAndStorage(inputs: Readonly<Record<string, unknown>> = {}) {
  const received: ReceivedRequest[] = [];
  const fileNames = new Map<string, string>();
  let artifactCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      received.push({
        method: request.method,
        path: url.pathname,
        headers: new Headers(request.headers),
        body,
      });
      const route = `${request.method} ${url.pathname}`;
      if (route === "POST /v1/threads") {
        return Response.json({ id: "thread_new", object: "thread" }, { status: 201 });
      }
      if (route === "POST /v1/artifacts") {
        const { byteSize, contentType, fileName } = JSON.parse(new TextDecoder().decode(body));
        artifactCount += 1;
        const artifactId = `artifact_${artifactCount}`;
        fileNames.set(artifactId, fileName);
        return Response.json(
          {
            artifact: { artifactId, status: "pending" },
            upload: {
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
              headers: {
                "content-length": String(byteSize),
                "content-type": contentType,
                "if-none-match": "*",
                "x-amz-checksum-sha256": `checksum-${artifactId}`,
              },
              method: "PUT",
              url: `${url.origin}/storage/${artifactId}?X-Amz-Signature=signature`,
            },
          },
          { status: 201 },
        );
      }
      if (request.method === "PUT" && url.pathname.startsWith("/storage/")) {
        return new Response(null, { status: 200 });
      }
      const completed = /^\/v1\/artifacts\/([^/]+)\/complete$/u.exec(url.pathname);
      if (request.method === "POST" && completed) {
        const artifactId = completed[1] ?? "";
        const input = inputs[fileNames.get(artifactId) ?? ""];
        return Response.json({
          artifactId,
          status: "available",
          ...(input === undefined ? {} : { input }),
        });
      }
      if (route === "POST /v1/agent-deployments/deployment_1/runs") {
        const submitted = JSON.parse(new TextDecoder().decode(body));
        return Response.json(
          {
            created: true,
            message: {
              body: submitted.content,
              inputArtifacts: submitted.inputArtifacts,
              threadId: submitted.threadId,
            },
            run: { id: "run_1", status: "queued", threadId: submitted.threadId },
            thread: { id: submitted.threadId },
          },
          { status: 202 },
        );
      }
      return Response.json({ title: `Unexpected ${route}` }, { status: 404 });
    },
  });
  servers.push(server);
  return {
    received,
    transport: [
      "--live",
      "--api-url",
      server.url.toString(),
      "--api-key",
      "test-api-key",
      "--env",
      "env_1",
    ],
  };
}

async function deployments(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "bin.ts"), ...args, "--json"], {
    env: {
      DEPLOYMENTS_CONFIG_DIR: await temporaryDirectory(),
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout };
}

describe("deployments chat --file", () => {
  it(
    "creates the thread in the workspace, uploads each file as run input typed by its name, and submits them",
    async () => {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, "a.csv"), CSV);
      await writeFile(join(directory, "b.pdf"), PDF);
      const api = fakePlatformApiAndStorage();
      const startedAt = Date.now();

      const result = await deployments([
        "chat",
        "--agent",
        "deployment_1",
        "--message",
        "What was Q3 revenue in the North region?",
        "--file",
        join(directory, "a.csv"),
        "--file",
        join(directory, "b.pdf"),
        "--workspace",
        "workspace_1",
        ...api.transport,
      ]);

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(routes(api.received)).toEqual([
        "POST /v1/threads",
        "POST /v1/artifacts",
        "PUT /storage/artifact_1",
        "POST /v1/artifacts/artifact_1/complete",
        "POST /v1/artifacts",
        "PUT /storage/artifact_2",
        "POST /v1/artifacts/artifact_2/complete",
        "POST /v1/agent-deployments/deployment_1/runs",
      ]);
      const [thread, csvUpload, csvPut, csvComplete, pdfUpload, pdfPut, , submit] = api.received;
      expect(json(thread)).toEqual({
        agentDeploymentId: "deployment_1",
        workspaceId: "workspace_1",
      });
      expect(
        [csvUpload, pdfUpload].map((upload): Record<string, unknown> => {
          const { retentionExpiresAt, ...body } = json(upload);
          const retentionDays = Math.round(
            (Date.parse(String(retentionExpiresAt)) - startedAt) / DAY_MS,
          );
          return { ...body, retentionDays };
        }),
      ).toEqual([
        {
          byteSize: 34,
          contentType: "text/csv",
          fileName: "a.csv",
          name: "a.csv",
          retentionDays: 30,
          sha256: "8bcd695bb8c927f99024876a5b603d239973719f572932c60f5fb76bc99f4c19",
          threadId: "thread_new",
          type: "input",
        },
        {
          byteSize: 15,
          contentType: "application/pdf",
          fileName: "b.pdf",
          name: "b.pdf",
          retentionDays: 30,
          sha256: "1e7313ace78f0fb481a486939b4885902663102818090805515553d84e0bbfd3",
          threadId: "thread_new",
          type: "input",
        },
      ]);
      expect([csvPut?.body, pdfPut?.body]).toEqual([CSV, PDF]);
      expect(
        Object.fromEntries(
          [
            "authorization",
            "content-length",
            "content-type",
            "if-none-match",
            "x-amz-checksum-sha256",
            "x-deployments-environment",
          ].map((name) => [name, csvPut?.headers.get(name) ?? null]),
        ),
      ).toEqual({
        authorization: null,
        "content-length": "34",
        "content-type": "text/csv",
        "if-none-match": "*",
        "x-amz-checksum-sha256": "checksum-artifact_1",
        "x-deployments-environment": null,
      });
      expect(csvComplete?.headers.get("authorization")).toBe("Bearer test-api-key");
      expect(json(submit)).toEqual({
        content: "What was Q3 revenue in the North region?",
        inputArtifacts: ["artifact_1", "artifact_2"],
        threadId: "thread_new",
        workspaceId: "workspace_1",
      });
      expect(JSON.parse(result.stdout).message.inputArtifacts).toEqual([
        "artifact_1",
        "artifact_2",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "attaches files to an existing thread and leaves a name with no known type to the server",
    async () => {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, "a.png"), PNG);
      await writeFile(join(directory, "README"), "Run bun install first.\n");
      const api = fakePlatformApiAndStorage();

      const result = await deployments([
        "chat",
        "--agent",
        "deployment_1",
        "--thread",
        "thread_existing",
        "--message",
        "and these?",
        "--file",
        join(directory, "a.png"),
        `--file=${join(directory, "README")}`,
        ...api.transport,
      ]);

      expect(result.exitCode).toBe(0);
      expect(routes(api.received)).toEqual([
        "POST /v1/artifacts",
        "PUT /storage/artifact_1",
        "POST /v1/artifacts/artifact_1/complete",
        "POST /v1/artifacts",
        "PUT /storage/artifact_2",
        "POST /v1/artifacts/artifact_2/complete",
        "POST /v1/agent-deployments/deployment_1/runs",
      ]);
      expect(
        api.received
          .filter(({ path }) => path === "/v1/artifacts")
          .map((request) => {
            const { contentType, fileName, threadId } = json(request);
            return [contentType, fileName, threadId];
          }),
      ).toEqual([
        ["image/png", "a.png", "thread_existing"],
        ["application/octet-stream", "README", "thread_existing"],
      ]);
      expect(json(api.received.at(-1))).toEqual({
        content: "and these?",
        inputArtifacts: ["artifact_1", "artifact_2"],
        threadId: "thread_existing",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "stops with the server's reason when a file can't be used, before submitting the run",
    async () => {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, "scan.pdf"), PDF);
      await writeFile(join(directory, "a.csv"), CSV);
      const api = fakePlatformApiAndStorage({
        "scan.pdf": {
          kind: "unusable",
          message:
            "the file has no readable text. If it is a scan, OCR found no text or isn't turned on.",
          reason: "no_text",
        },
      });

      const result = await deployments([
        "chat",
        "--agent",
        "deployment_1",
        "--message",
        "Summarize",
        "--file",
        join(directory, "scan.pdf"),
        "--file",
        join(directory, "a.csv"),
        ...api.transport,
      ]);

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 7,
        stderr:
          "Error: scan.pdf can't be attached: the file has no readable text. If it is a scan, OCR found no text or isn't turned on.",
      });
      expect(routes(api.received)).toEqual([
        "POST /v1/threads",
        "POST /v1/artifacts",
        "PUT /storage/artifact_1",
        "POST /v1/artifacts/artifact_1/complete",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.each([
    {
      name: "a legacy Excel workbook",
      files: { "q3.xls": CSV },
      error: (directory: string) =>
        `${join(directory, "q3.xls")} can't be attached: legacy Office files (.doc, .xls, .ppt) aren't supported. Save it as .docx or .xlsx and attach it again.`,
    },
    {
      name: "a PowerPoint deck",
      files: { "deck.pptx": PDF },
      error: (directory: string) =>
        `${join(directory, "deck.pptx")} can't be attached: this file type isn't supported. Attach a PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown, JSON, HTML, or ZIP file, or a JPEG, PNG, or WebP image.`,
    },
    {
      name: "an 11 MiB file",
      files: { "large.pdf": new Uint8Array(11 * MIB) },
      error: (directory: string) =>
        `${join(directory, "large.pdf")} can't be attached: the file is larger than 10 MiB.`,
    },
    {
      name: "nine files",
      files: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`notes-${index}.txt`, CSV]),
      ),
      error: () => "Chat accepts at most 8 files.",
    },
    {
      name: "21 MiB of images",
      files: {
        "a.png": new Uint8Array(7 * MIB),
        "b.png": new Uint8Array(7 * MIB),
        "c.png": new Uint8Array(7 * MIB),
      },
      error: () => "The attached images and audio total more than 20 MiB.",
    },
    {
      name: "a missing file",
      files: {},
      args: (directory: string) => ["--file", join(directory, "missing.pdf")],
      error: (directory: string) => `Unable to read file: ${join(directory, "missing.pdf")}`,
    },
    {
      name: "an idempotency key the API would refuse",
      files: { "a.csv": CSV },
      args: () => ["--idempotency-key", " padded"],
      error: () =>
        "Agent run submission requires a non-empty idempotency key of at most 256 UTF-8 bytes without surrounding whitespace or control characters.",
    },
  ])(
    "rejects $name before sending any request",
    async ({ args, files, error }) => {
      const directory = await temporaryDirectory();
      const attached: string[] = [];
      for (const [fileName, bytes] of Object.entries(files)) {
        await writeFile(join(directory, fileName), bytes);
        attached.push("--file", join(directory, fileName));
      }
      const api = fakePlatformApiAndStorage();

      const result = await deployments([
        "chat",
        "--agent",
        "deployment_1",
        "--message",
        "hi",
        ...attached,
        ...(args?.(directory) ?? []),
        ...api.transport,
      ]);

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 7,
        stderr: `Error: ${error(directory)}`,
      });
      expect(routes(api.received)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses --image as an unknown option",
    async () => {
      const image = join(await temporaryDirectory(), "fixture.png");
      await writeFile(image, PNG);
      const api = fakePlatformApiAndStorage();

      const result = await deployments([
        "chat",
        "--agent",
        "deployment_1",
        "--message",
        "hi",
        "--image",
        image,
        ...api.transport,
      ]);

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 2,
        stderr: "Error: Unknown option: --image",
      });
      expect(routes(api.received)).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "attaches files in mock mode without sending bytes anywhere",
    async () => {
      const file = join(await temporaryDirectory(), "notes.pdf");
      await writeFile(file, PDF);

      const result = await deployments([
        "chat",
        "--mock",
        "--agent",
        "deployment_1",
        "--message",
        "hi",
        "--file",
        file,
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).message.inputArtifacts).toEqual([
        "01ARZ3NDEKTSV4RRFFQ69G5FB9",
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
