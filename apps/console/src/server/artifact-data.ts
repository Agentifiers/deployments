import "@tanstack/react-start/server-only";
import type { ArtifactFilters } from "../artifacts/filters.ts";
import type { PresignedUrl } from "../presigned.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, PlatformRequestError, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

type ArtifactResponse = RouteResponse<"getArtifact">;

/**
 * An artifact as the console shows it. Its free-form metadata is JSON a server function cannot
 * type, so it travels as the pretty-printed text the detail page shows.
 */
export type Artifact = Omit<ArtifactResponse, "metadata"> & {
  readonly metadataJson?: string;
};

/** Which artifacts a list holds: a run's, a thread's, or the environment's, filtered. */
export type ArtifactOwner =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "environment"; readonly filters: ArtifactFilters };

function artifactView({ metadata, ...artifact }: ArtifactResponse): Artifact {
  return metadata === undefined
    ? artifact
    : { ...artifact, metadataJson: JSON.stringify(metadata, null, 2) };
}

function ownerQuery(owner: ArtifactOwner) {
  if (owner.kind === "run") return { runId: owner.runId };
  if (owner.kind === "thread") return { threadId: owner.threadId };
  return owner.filters;
}

export async function loadArtifactPage(
  accessToken: string,
  scope: EnvironmentScope,
  owner: ArtifactOwner,
  cursor: string | undefined,
): Promise<Page<Artifact>> {
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listArtifacts",
        { query: { ...ownerQuery(owner), cursor: pageCursor, limit }, scope },
        accessToken,
      ).then(({ artifacts, nextCursor }) => ({ items: artifacts, nextCursor })),
    cursor,
    PAGE_SIZE,
  );
  return { ...page, items: page.items.map(artifactView) };
}

export async function loadArtifact(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
): Promise<Artifact> {
  return artifactView(await callRoute("getArtifact", { path: { artifactId }, scope }, accessToken));
}

/** How long a link the console mints stays valid; the API allows 60 to 3600 seconds. */
export const ARTIFACT_LINK_SECONDS = { copy: 3600, download: 300, preview: 60 } as const;
export type ArtifactLinkPurpose = keyof typeof ARTIFACT_LINK_SECONDS;

/**
 * A short-lived signed link to the artifact's bytes. Every link asks storage for an attachment, so
 * a browser that opens one saves the file instead of rendering it on the storage origin; an
 * `<img>` still shows an image from it.
 */
export function createArtifactLink(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
  purpose: ArtifactLinkPurpose = "download",
): Promise<PresignedUrl> {
  return callRoute(
    "createArtifactAccessUrl",
    {
      body: { disposition: "attachment", expiresInSeconds: ARTIFACT_LINK_SECONDS[purpose] },
      path: { artifactId },
      scope,
    },
    accessToken,
  );
}

export type ArtifactText =
  | { readonly kind: "binary" }
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean };

/**
 * Reads at most `limit` bytes of a response body as UTF-8 text. Bytes that do not decode, or a NUL,
 * make it binary; a cut at `limit` may split one character, so a trailing replacement is dropped.
 */
export async function readTextPrefix(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<ArtifactText> {
  const reader = body.getReader();
  const bytes = new Uint8Array(limit + 1);
  let read = 0;
  while (read <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, bytes.byteLength - read);
    bytes.set(value.subarray(0, take), read);
    read += take;
  }
  await reader.cancel();
  const truncated = read > limit;
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.min(read, limit)));
  const shown = truncated ? text.replace(/\uFFFD+$/u, "") : text;
  if (shown.includes("\uFFFD") || shown.includes("\u0000")) return { kind: "binary" };
  return { kind: "text", text: shown, truncated };
}

/**
 * Reads the start of the artifact through a fresh signed link. The console server reads it, so
 * the bucket needs no browser read access and the bytes reach the page only as text.
 */
export async function loadArtifactText(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
  limit: number,
): Promise<ArtifactText> {
  const { url } = await createArtifactLink(accessToken, scope, artifactId, "preview");
  if (new URL(url).protocol !== "https:") {
    throw new PlatformRequestError("The platform returned an artifact link that is not https.");
  }
  const response = await fetch(url, { headers: { range: `bytes=0-${limit}` }, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new PlatformRequestError(`The artifact could not be read (status ${response.status}).`);
  }
  return readTextPrefix(response.body, limit);
}

/** `null` keeps the artifact until it is deleted with its run, thread, or organization. */
export async function updateArtifactRetention(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
  expectedVersion: number,
  retentionExpiresAt: string | null,
): Promise<Artifact> {
  return artifactView(
    await callRoute(
      "updateArtifactRetention",
      { body: { expectedVersion, retentionExpiresAt }, path: { artifactId }, scope },
      accessToken,
    ),
  );
}

export async function deleteArtifact(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
): Promise<Artifact> {
  return artifactView(
    await callRoute("deleteArtifact", { path: { artifactId }, scope }, accessToken),
  );
}

/** What the upload dialog sends; the browser computed `sha256` from the file it will send. */
export interface ArtifactUploadRequest {
  readonly byteSize: number;
  readonly contentType: string;
  readonly fileName: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly sha256: string;
  readonly threadId?: string;
  readonly type: string;
  readonly visibility: "organization" | "private";
}

export interface CreatedArtifactUpload {
  readonly artifactId: string;
  readonly upload: {
    readonly expiresAt: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
  };
}

export async function createArtifactUpload(
  accessToken: string,
  scope: EnvironmentScope,
  request: ArtifactUploadRequest,
): Promise<CreatedArtifactUpload> {
  const created = await callRoute(
    "createArtifactUpload",
    {
      body: decodeRequestBody("createArtifactUpload", "CreateArtifactUploadRequest", request),
      scope,
    },
    accessToken,
  );
  return {
    artifactId: created.artifact.artifactId,
    upload: {
      expiresAt: created.upload.expiresAt,
      headers: created.upload.headers,
      url: created.upload.url,
    },
  };
}

export async function completeArtifactUpload(
  accessToken: string,
  scope: EnvironmentScope,
  artifactId: string,
): Promise<Artifact> {
  return artifactView(
    await callRoute("completeArtifactUpload", { path: { artifactId }, scope }, accessToken),
  );
}

/**
 * Starts a run that reads one uploaded input file. The file was uploaded to `threadId`, so the run
 * continues that thread; the API checks the file is an `input` upload by the same caller.
 */
export async function startRunWithInput(
  accessToken: string,
  scope: EnvironmentScope,
  input: {
    readonly agentDeploymentId: string;
    readonly artifactId: string;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly threadId: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const submitted = await callRoute(
    "submitAgentRun",
    {
      body: decodeRequestBody("submitAgentRun", "SubmitAgentRunRequest", {
        content: input.content,
        inputArtifacts: [input.artifactId],
        threadId: input.threadId,
      }),
      idempotencyKey: input.idempotencyKey,
      path: { agentDeploymentId: input.agentDeploymentId },
      scope,
    },
    accessToken,
  );
  return { runId: submitted.run.id, threadId: submitted.thread.id };
}

/** A new thread on a deployment, for an input file the next run reads. */
export async function createInputThread(
  accessToken: string,
  scope: EnvironmentScope,
  agentDeploymentId: string,
): Promise<string> {
  const thread = await callRoute(
    "createThread",
    {
      body: decodeRequestBody("createThread", "CreateThreadRequest", {
        agentDeploymentId,
        channel: "console",
      }),
      scope,
    },
    accessToken,
  );
  return thread.id;
}
