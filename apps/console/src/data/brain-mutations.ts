import { createServerFn } from "@tanstack/react-start";
import type { CaptureBody, ResolveBody } from "../brains/content.ts";
import type { CreateBrainBody, GrantBody, MountBody, UpdateBrainBody } from "../brains/model.ts";
import type { AskBody, FeedbackBody, SearchBody } from "../brains/query.ts";
import {
  CONSOLE_BRAIN_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_IDENTITY_LENGTH,
  MAX_UPLOAD_TITLE_LENGTH,
} from "../brains/upload.ts";
import {
  archiveBrain,
  askBrains,
  captureBrainLifecycle,
  createBrain,
  createBrainGrant,
  createBrainMount,
  createUploadSource,
  eraseBrain,
  recordBrainFeedback,
  resolveBrainReviewItem,
  revokeBrainGrant,
  revokeBrainMount,
  searchBrains,
  updateBrain,
  uploadBrainDocument,
} from "../server/brain-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  keyedInputAt,
  requireBody,
  type KeyedInput,
  type KeyedInputAt,
} from "./server-input.ts";

interface KeyedBrainInput extends KeyedInputAt<"organization"> {
  readonly brainId: string;
}

function expectedVersion(input: unknown): number {
  const { expectedVersion: version } = fields(input);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new TypeError("expectedVersion must be a non-negative integer.");
  }
  return version;
}

async function organizationCall<
  Data extends { readonly scope: { readonly organizationId: string } },
>(data: Data) {
  return {
    ...data,
    accessToken: await requireAccessToken(),
    organizationId: data.scope.organizationId,
  };
}

export const createBrainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization"> & { readonly body: CreateBrainBody }) => ({
    ...keyedInputAt("organization", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createBrain(await organizationCall(data)));

export const updateBrainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly body: UpdateBrainBody }) => ({
    ...keyedInputAt("organization", input, ["brainId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => updateBrain(await organizationCall(data)));

export const createUploadSourceFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly name: string }) => {
    const { name } = fields(input);
    if (typeof name !== "string") throw new TypeError("name must be a string.");
    return { ...keyedInputAt("organization", input, ["brainId"]), name };
  })
  .handler(async ({ data }) => createUploadSource(await organizationCall(data)));

export const createBrainGrantFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly body: GrantBody }) => ({
    ...keyedInputAt("organization", input, ["brainId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createBrainGrant(await organizationCall(data)));

export const revokeBrainGrantFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedBrainInput & { readonly expectedVersion: number; readonly grantId: string }) => ({
      ...keyedInputAt("organization", input, ["brainId", "grantId"]),
      expectedVersion: expectedVersion(input),
    }),
  )
  .handler(async ({ data }) => revokeBrainGrant(await organizationCall(data)));

export const createBrainMountFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly body: MountBody }) => ({
    ...keyedInputAt("organization", input, ["brainId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createBrainMount(await organizationCall(data)));

export const revokeBrainMountFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedBrainInput & { readonly expectedVersion: number; readonly mountId: string }) => ({
      ...keyedInputAt("organization", input, ["brainId", "mountId"]),
      expectedVersion: expectedVersion(input),
    }),
  )
  .handler(async ({ data }) => revokeBrainMount(await organizationCall(data)));

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const MAX_BASE64_LENGTH = Math.ceil(CONSOLE_BRAIN_UPLOAD_MAX_BYTES / 3) * 4;

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${name} must be 1 to ${max} characters.`);
  }
  return value;
}

export const uploadBrainDocumentFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedBrainInput & {
        readonly contentBase64: string;
        readonly externalItemIdentity: string;
        readonly mediaType: string;
        readonly retry: boolean;
        readonly sourceId: string;
        readonly title?: string;
      },
    ) => {
      const { contentBase64, externalItemIdentity, mediaType, retry, title } = fields(input);
      if (
        typeof contentBase64 !== "string" ||
        contentBase64.length > MAX_BASE64_LENGTH ||
        !BASE64.test(contentBase64)
      ) {
        throw new TypeError("contentBase64 must be base64 within the console's upload cap.");
      }
      if (typeof mediaType !== "string") throw new TypeError("mediaType must be a string.");
      if (typeof retry !== "boolean") throw new TypeError("retry must be a boolean.");
      return {
        ...keyedInputAt("organization", input, ["brainId", "sourceId"]),
        contentBase64,
        externalItemIdentity: boundedText(
          externalItemIdentity,
          "externalItemIdentity",
          MAX_UPLOAD_IDENTITY_LENGTH,
        ),
        mediaType,
        retry,
        ...(title === undefined
          ? {}
          : { title: boundedText(title, "title", MAX_UPLOAD_TITLE_LENGTH) }),
      };
    },
  )
  .handler(async ({ data }) => uploadBrainDocument(await organizationCall(data)));

export const captureBrainLifecycleFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedBrainInput & { readonly body: CaptureBody; readonly sourceId: string }) => ({
      ...keyedInputAt("organization", input, ["brainId", "sourceId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => captureBrainLifecycle(await organizationCall(data)));

export const resolveBrainReviewItemFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedBrainInput & { readonly body: ResolveBody; readonly reviewItemId: string }) => ({
      ...keyedInputAt("organization", input, ["brainId", "reviewItemId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => resolveBrainReviewItem(await organizationCall(data)));

export const archiveBrainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly expectedVersion: number }) => ({
    ...keyedInputAt("organization", input, ["brainId"]),
    expectedVersion: expectedVersion(input),
  }))
  .handler(async ({ data }) => archiveBrain(await organizationCall(data)));

export const eraseBrainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBrainInput & { readonly expectedVersion: number }) => ({
    ...keyedInputAt("organization", input, ["brainId"]),
    expectedVersion: expectedVersion(input),
  }))
  .handler(async ({ data }) => eraseBrain(await organizationCall(data)));

export const searchBrainsFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: SearchBody }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => searchBrains({ ...data, accessToken: await requireAccessToken() }));

export const askBrainsFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: AskBody }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => askBrains({ ...data, accessToken: await requireAccessToken() }));

export const recordBrainFeedbackFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInputAt<"organization"> & {
        readonly body: FeedbackBody;
        readonly queryAttemptId: string;
      },
    ) => ({
      ...keyedInputAt("organization", input, ["queryAttemptId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => recordBrainFeedback(await organizationCall(data)));
