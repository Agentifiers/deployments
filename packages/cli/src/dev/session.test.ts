import type {
  CreatePreviewRequest,
  PreviewResponse,
  SubmitAgentRunResponse,
} from "@deployments-ai/api-contract/runtime";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import { loadManifest } from "./manifest.ts";
import { PreviewSession, type DevPreviewsApi } from "./session.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function manifest(instructions = "Answer briefly.") {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
    spec: {
      capabilities: { tools: [] },
      instructions,
      memory: { mode: "off" },
      model: { id: "openrouter/default" },
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

interface Recorded {
  readonly created: (typeof CreatePreviewRequest.Encoded)[];
  readonly deleted: string[];
  readonly turns: { previewId: string; threadId?: string }[];
  readonly idempotencyKeys: string[];
}

function fakePreviews(): { api: DevPreviewsApi; recorded: Recorded } {
  const recorded: Recorded = { created: [], deleted: [], turns: [], idempotencyKeys: [] };
  const api: DevPreviewsApi = {
    async create(input, options) {
      recorded.created.push(input);
      recorded.idempotencyKeys.push(options.idempotencyKey);
      const preview = { id: `preview_${recorded.created.length}`, agentName: "Example Assistant" };
      return { data: preview as PreviewResponse, mocked: true, requestId: "request" };
    },
    async delete(previewId) {
      recorded.deleted.push(previewId);
      return { data: { id: previewId } as PreviewResponse, mocked: true, requestId: "request" };
    },
    async submitTurn(previewId, input, options) {
      recorded.turns.push({ previewId, ...(input.threadId ? { threadId: input.threadId } : {}) });
      recorded.idempotencyKeys.push(options.idempotencyKey);
      const thread = { id: input.threadId ?? `thread_${recorded.turns.length}` };
      const response = { created: true, thread, run: { id: `run_${recorded.turns.length}` } };
      return {
        data: response as unknown as SubmitAgentRunResponse,
        mocked: true,
        requestId: "request",
      };
    },
  };
  return { api, recorded };
}

async function harness(initial: unknown = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), "deployments-dev-"));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, "agent.json");
  await writeFile(manifestPath, JSON.stringify(initial));
  const { api, recorded } = fakePreviews();
  const notices: string[] = [];
  const session = new PreviewSession({
    previews: api,
    manifestPath,
    loadManifest,
    configuration: { fromAgentDeploymentId: "deployment_1" },
    ttlSeconds: 600,
    notify: (message) => notices.push(message),
  });
  return { manifestPath, notices, recorded, session };
}

describe("deployments dev preview session", () => {
  it("continues the same preview thread while the manifest is unchanged", async () => {
    const { recorded, session, notices } = await harness();

    await session.submitTurn("first");
    await session.submitTurn("second");

    expect(recorded.created).toHaveLength(1);
    expect(recorded.created[0]).toMatchObject({
      fromAgentDeploymentId: "deployment_1",
      ttlSeconds: 600,
    });
    expect(recorded.turns).toEqual([
      { previewId: "preview_1" },
      { previewId: "preview_1", threadId: "thread_1" },
    ]);
    expect(recorded.deleted).toEqual([]);
    expect(notices).toEqual([]);
    expect(new Set(recorded.idempotencyKeys).size).toBe(recorded.idempotencyKeys.length);
  });

  it("keeps the thread when an edit leaves the canonical manifest unchanged", async () => {
    const { manifestPath, recorded, session } = await harness();
    await session.submitTurn("first");

    const reordered = manifest();
    await writeFile(
      manifestPath,
      `${JSON.stringify({ spec: reordered.spec, metadata: reordered.metadata, kind: reordered.kind, apiVersion: reordered.apiVersion }, null, 4)}\n`,
    );
    await session.submitTurn("second");

    expect(recorded.created).toHaveLength(1);
    expect(recorded.turns.at(-1)).toEqual({ previewId: "preview_1", threadId: "thread_1" });
  });

  it("creates a new preview and thread when the manifest content changes", async () => {
    const { manifestPath, notices, recorded, session } = await harness();
    await session.submitTurn("first");

    await writeFile(manifestPath, JSON.stringify(manifest("Answer in detail.")));
    await session.submitTurn("second");
    await session.submitTurn("third");

    expect(recorded.created).toHaveLength(2);
    expect(recorded.created[1]?.manifest.spec.instructions).toBe("Answer in detail.");
    expect(recorded.deleted).toEqual(["preview_1"]);
    expect(recorded.turns).toEqual([
      { previewId: "preview_1" },
      { previewId: "preview_2" },
      { previewId: "preview_2", threadId: "thread_2" },
    ]);
    expect(notices).toEqual(["Manifest changed; started preview preview_2 with a new thread."]);
  });

  it("keeps the current preview when the edited manifest is invalid", async () => {
    const { manifestPath, recorded, session } = await harness();
    await session.submitTurn("first");

    await writeFile(manifestPath, JSON.stringify({ ...manifest(), kind: "Workflow" }));
    expect(session.submitTurn("second")).rejects.toBeInstanceOf(CliError);

    expect(recorded.created).toHaveLength(1);
    expect(recorded.turns).toHaveLength(1);
    expect(String(session.preview?.id)).toBe("preview_1");
    expect(session.threadId).toBe("thread_1");
  });

  it("expires the current preview on close", async () => {
    const { recorded, session } = await harness();
    await session.submitTurn("first");

    await session.close();
    await session.close();

    expect(recorded.deleted).toEqual(["preview_1"]);
    expect(session.preview).toBeUndefined();
  });
});
