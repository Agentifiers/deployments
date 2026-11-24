import { createServerFn } from "@tanstack/react-start";
import {
  completeArtifactUpload,
  createArtifactUpload,
  createInputThread,
  deleteArtifact,
  startRunWithInput,
  type ArtifactUploadRequest,
} from "../server/artifact-data.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  requireIds,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RUN_MESSAGE_LENGTH = 32_000;

function uploadRequest(input: unknown): ArtifactUploadRequest {
  const value = fields(input);
  const { byteSize, contentType, fileName, metadata, name, sha256, type, visibility } = value;
  if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize)) {
    throw new TypeError("byteSize must be an integer.");
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new TypeError("sha256 must be a lowercase hex SHA-256 digest.");
  }
  if (
    typeof contentType !== "string" ||
    typeof fileName !== "string" ||
    typeof name !== "string" ||
    typeof type !== "string"
  ) {
    throw new TypeError("contentType, fileName, name, and type must be strings.");
  }
  if (visibility !== "organization" && visibility !== "private") {
    throw new TypeError("visibility must be organization or private.");
  }
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
  ) {
    throw new TypeError("metadata must be a JSON object.");
  }
  return {
    byteSize,
    contentType,
    fileName,
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
    name,
    sha256,
    ...(value.threadId === undefined ? {} : requireIds(value, ["threadId"])),
    type,
    visibility,
  };
}

export const createArtifactUploadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly request: ArtifactUploadRequest }) => ({
    ...scopedInput(input),
    request: uploadRequest(fields(input).request),
  }))
  .handler(async ({ data }) =>
    createArtifactUpload(await requireAccessToken(), data.scope, data.request),
  );

export const completeArtifactUploadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly artifactId: string }) =>
    scopedInput(input, ["artifactId"]),
  )
  .handler(async ({ data }) =>
    completeArtifactUpload(await requireAccessToken(), data.scope, data.artifactId),
  );

export const deleteArtifactFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly artifactId: string }) =>
    scopedInput(input, ["artifactId"]),
  )
  .handler(async ({ data }) =>
    deleteArtifact(await requireAccessToken(), data.scope, data.artifactId),
  );

export const createInputThreadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly agentDeploymentId: string }) =>
    scopedInput(input, ["agentDeploymentId"]),
  )
  .handler(async ({ data }) =>
    createInputThread(await requireAccessToken(), data.scope, data.agentDeploymentId),
  );

export const startRunWithInputFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly agentDeploymentId: string;
        readonly artifactId: string;
        readonly content: string;
        readonly threadId: string;
      },
    ) => {
      const { content } = fields(input);
      if (
        typeof content !== "string" ||
        content.trim() !== content ||
        content === "" ||
        content.length > MAX_RUN_MESSAGE_LENGTH
      ) {
        throw new TypeError("content must be a non-empty message without surrounding spaces.");
      }
      return {
        ...keyedInput(input, ["agentDeploymentId", "artifactId", "threadId"]),
        content,
      };
    },
  )
  .handler(async ({ data }) => startRunWithInput(await requireAccessToken(), data.scope, data));
