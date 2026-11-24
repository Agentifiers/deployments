import { createServerFn } from "@tanstack/react-start";
import {
  ARTIFACT_LINK_SECONDS,
  createArtifactLink,
  updateArtifactRetention,
  type ArtifactLinkPurpose,
} from "../server/artifact-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { archiveThread, eraseEndUser, eraseThread } from "../server/thread-data.ts";
import { fields, instantInput, scopedInput, type ScopedInput } from "./server-input.ts";

const MAX_END_USER_ID_LENGTH = 256;

export const archiveThreadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly threadId: string }) =>
    scopedInput(input, ["threadId"]),
  )
  .handler(async ({ data }) =>
    archiveThread(await requireAccessToken(), data.scope, data.threadId),
  );

export const eraseThreadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly threadId: string }) =>
    scopedInput(input, ["threadId"]),
  )
  .handler(async ({ data }) => eraseThread(await requireAccessToken(), data.scope, data.threadId));

export const eraseEndUserFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly endUserId: string }) => {
    const { endUserId } = fields(input);
    if (
      typeof endUserId !== "string" ||
      endUserId.length === 0 ||
      endUserId.length > MAX_END_USER_ID_LENGTH
    ) {
      throw new TypeError("endUserId must be 1 to 256 characters.");
    }
    return { ...scopedInput(input), endUserId };
  })
  .handler(async ({ data }) =>
    eraseEndUser(await requireAccessToken(), data.scope, data.endUserId),
  );

export const createArtifactLinkFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: ScopedInput & { readonly artifactId: string; readonly purpose?: ArtifactLinkPurpose },
    ) => {
      const { purpose = "download" } = fields(input);
      if (typeof purpose !== "string" || !Object.hasOwn(ARTIFACT_LINK_SECONDS, purpose)) {
        throw new TypeError("purpose must be copy, download, or preview.");
      }
      return { ...scopedInput(input, ["artifactId"]), purpose: purpose as ArtifactLinkPurpose };
    },
  )
  .handler(async ({ data }) =>
    createArtifactLink(await requireAccessToken(), data.scope, data.artifactId, data.purpose),
  );

export const updateArtifactRetentionFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: ScopedInput & {
        readonly artifactId: string;
        readonly expectedVersion: number;
        readonly retentionExpiresAt: string | null;
      },
    ) => {
      const { expectedVersion, retentionExpiresAt } = fields(input);
      if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion)) {
        throw new TypeError("expectedVersion must be an integer.");
      }
      return {
        ...scopedInput(input, ["artifactId"]),
        expectedVersion,
        retentionExpiresAt:
          retentionExpiresAt === null
            ? null
            : instantInput(retentionExpiresAt, "retentionExpiresAt"),
      };
    },
  )
  .handler(async ({ data }) =>
    updateArtifactRetention(
      await requireAccessToken(),
      data.scope,
      data.artifactId,
      data.expectedVersion,
      data.retentionExpiresAt,
    ),
  );
