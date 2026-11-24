import type {
  CreatePreviewRequest,
  PreviewResponse,
  SubmitAgentRunResponse,
} from "@deployments-ai/api-contract/runtime";
import type { RuntimeSdk } from "@agentifiers/deployments-sdk";
import { randomUUID } from "node:crypto";
import { errorMessage } from "../errors.ts";
import type { LoadedManifest } from "./manifest.ts";

export type DevPreviewsApi = Pick<RuntimeSdk["previews"], "create" | "delete" | "submitTurn">;

export interface PreviewSessionOptions {
  readonly previews: DevPreviewsApi;
  readonly manifestPath: string;
  readonly loadManifest: (path: string) => Promise<LoadedManifest>;
  /** Runtime configuration sent with every preview this session creates. */
  readonly configuration: Pick<
    typeof CreatePreviewRequest.Encoded,
    "fromAgentDeploymentId" | "runtimeConfig"
  >;
  readonly ttlSeconds?: number;
  readonly notify: (message: string) => void;
  readonly newIdempotencyKey?: () => string;
}

/**
 * Owns the preview of a local manifest file: each turn re-reads the manifest, replaces the
 * preview (starting a new thread) when its canonical hash changed, and otherwise continues the
 * current thread.
 */
export class PreviewSession {
  readonly #options: PreviewSessionOptions;
  readonly #newIdempotencyKey: () => string;
  #preview: PreviewResponse | undefined;
  #contentHash: string | undefined;
  #threadId: string | undefined;

  constructor(options: PreviewSessionOptions) {
    this.#options = options;
    this.#newIdempotencyKey = options.newIdempotencyKey ?? randomUUID;
  }

  get preview(): PreviewResponse | undefined {
    return this.#preview;
  }

  get threadId(): string | undefined {
    return this.#threadId;
  }

  /** Creates the preview for the current manifest unless one already matches it. */
  async start(): Promise<PreviewResponse> {
    return this.#previewFor(await this.#options.loadManifest(this.#options.manifestPath));
  }

  async submitTurn(content: string): Promise<SubmitAgentRunResponse> {
    const preview = await this.start();
    const response = await this.#options.previews.submitTurn(
      preview.id,
      { content, ...(this.#threadId ? { threadId: this.#threadId } : {}) },
      { idempotencyKey: this.#newIdempotencyKey() },
    );
    this.#threadId = response.data.thread.id;
    return response.data;
  }

  /** Expires the current preview; the session can start again afterwards. */
  async close(): Promise<void> {
    const preview = this.#preview;
    this.#preview = undefined;
    this.#contentHash = undefined;
    this.#threadId = undefined;
    if (preview) await this.#options.previews.delete(preview.id);
  }

  async #previewFor(loaded: LoadedManifest): Promise<PreviewResponse> {
    if (this.#preview && this.#contentHash === loaded.contentHash) return this.#preview;
    const superseded = this.#preview;
    const created = await this.#options.previews.create(
      {
        manifest: loaded.manifest,
        ...this.#options.configuration,
        ...(this.#options.ttlSeconds !== undefined ? { ttlSeconds: this.#options.ttlSeconds } : {}),
      },
      { idempotencyKey: this.#newIdempotencyKey() },
    );
    this.#preview = created.data;
    this.#contentHash = loaded.contentHash;
    this.#threadId = undefined;
    if (!superseded) return created.data;
    this.#options.notify(`Manifest changed; started preview ${created.data.id} with a new thread.`);
    try {
      await this.#options.previews.delete(superseded.id);
    } catch (error) {
      this.#options.notify(
        `Could not expire superseded preview ${superseded.id}: ${errorMessage(error)}`,
      );
    }
    return created.data;
  }
}
