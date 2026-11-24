import "@tanstack/react-start/server-only";
import { createHash } from "node:crypto";
import {
  documentView,
  reviewItemView,
  type BrainDocumentView,
  type BrainReviewItemView,
} from "../brains/content.ts";
import { erasureView, type BrainErasure } from "../brains/erasure.ts";
import type { BrainQueryResult } from "../brains/query.ts";
import { CONSOLE_BRAIN_UPLOAD_MAX_BYTES, nextUploadStep } from "../brains/upload.ts";
import { BRAIN_UPLOAD_RESTART, PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, PlatformRequestError, type PlatformApiClient } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

type Platform = Pick<PlatformApiClient, "callRoute">;

const platform: Platform = { callRoute };

interface BrainMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

interface BrainChange extends BrainMutation {
  readonly brainId: string;
}

interface Versioned extends BrainChange {
  readonly expectedVersion: number;
}

export function createBrain({
  accessToken,
  body,
  idempotencyKey,
  organizationId,
}: BrainMutation & { readonly body: unknown }) {
  return callRoute(
    "createBrain",
    {
      body: decodeRequestBody("createBrain", "CreateBrainRequest", body),
      idempotencyKey,
      scope: { organizationId },
    },
    accessToken,
  );
}

export function updateBrain({
  accessToken,
  body,
  brainId,
  idempotencyKey,
  organizationId,
}: BrainChange & {
  readonly body: unknown;
}) {
  return callRoute(
    "updateBrain",
    {
      body: decodeRequestBody("updateBrain", "UpdateBrainRequest", body),
      idempotencyKey,
      path: { brainId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export async function createUploadSource({
  accessToken,
  brainId,
  idempotencyKey,
  name,
  organizationId,
}: BrainChange & { readonly name: string }) {
  const { id, name: created } = await callRoute(
    "createBrainSource",
    {
      body: decodeRequestBody("createBrainSource", "CreateBrainSourceRequest", {
        kind: "upload",
        name,
      }),
      idempotencyKey,
      path: { brainId },
      scope: { organizationId },
    },
    accessToken,
  );
  return { id, name: created };
}

export function createBrainGrant({
  accessToken,
  body,
  brainId,
  idempotencyKey,
  organizationId,
}: BrainChange & {
  readonly body: unknown;
}) {
  return callRoute(
    "createBrainGrant",
    {
      body: decodeRequestBody("createBrainGrant", "CreateBrainGrantRequest", body),
      idempotencyKey,
      path: { brainId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function revokeBrainGrant({
  accessToken,
  brainId,
  expectedVersion,
  grantId,
  idempotencyKey,
  organizationId,
}: Versioned & {
  readonly grantId: string;
}) {
  return callRoute(
    "revokeBrainGrant",
    {
      body: { expectedVersion },
      idempotencyKey,
      path: { brainId, grantId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function createBrainMount({
  accessToken,
  body,
  brainId,
  idempotencyKey,
  organizationId,
}: BrainChange & {
  readonly body: unknown;
}) {
  return callRoute(
    "createBrainMount",
    {
      body: decodeRequestBody("createBrainMount", "CreateBrainMountRequest", body),
      idempotencyKey,
      path: { brainId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function revokeBrainMount({
  accessToken,
  brainId,
  expectedVersion,
  idempotencyKey,
  mountId,
  organizationId,
}: Versioned & {
  readonly mountId: string;
}) {
  return callRoute(
    "revokeBrainMount",
    {
      body: { expectedVersion },
      idempotencyKey,
      path: { brainId, mountId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function archiveBrain({
  accessToken,
  brainId,
  expectedVersion,
  idempotencyKey,
  organizationId,
}: Versioned) {
  return callRoute(
    "archiveBrain",
    { body: { expectedVersion }, idempotencyKey, path: { brainId }, scope: { organizationId } },
    accessToken,
  );
}

export async function eraseBrain({
  accessToken,
  brainId,
  expectedVersion,
  idempotencyKey,
  organizationId,
}: Versioned): Promise<BrainErasure> {
  return erasureView(
    await callRoute(
      "eraseBrain",
      { body: { expectedVersion }, idempotencyKey, path: { brainId }, scope: { organizationId } },
      accessToken,
    ),
  );
}

interface BrainQuery {
  readonly accessToken: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export async function searchBrains(
  { accessToken, body, idempotencyKey, scope }: BrainQuery,
  client: Platform = platform,
): Promise<BrainQueryResult> {
  const results = await client.callRoute(
    "searchBrains",
    { body: decodeRequestBody("searchBrains", "BrainSearchRequest", body), idempotencyKey, scope },
    accessToken,
  );
  return { mode: "search", results };
}

export async function askBrains(
  { accessToken, body, idempotencyKey, scope }: BrainQuery,
  client: Platform = platform,
): Promise<BrainQueryResult> {
  const answer = await client.callRoute(
    "askBrains",
    { body: decodeRequestBody("askBrains", "BrainAskRequest", body), idempotencyKey, scope },
    accessToken,
  );
  return { answer, mode: "ask" };
}

export function recordBrainFeedback({
  accessToken,
  body,
  idempotencyKey,
  organizationId,
  queryAttemptId,
}: BrainMutation & { readonly body: unknown; readonly queryAttemptId: string }) {
  return callRoute(
    "recordBrainFeedback",
    {
      body: decodeRequestBody("recordBrainFeedback", "RecordBrainFeedbackRequest", body),
      idempotencyKey,
      path: { queryAttemptId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export interface BrainUpload extends BrainChange {
  readonly contentBase64: string;
  readonly externalItemIdentity: string;
  readonly mediaType: string;
  /** An earlier submission went out under this key, so the ticket response may be a stale replay. */
  readonly retry: boolean;
  readonly sourceId: string;
  readonly title?: string;
}

export interface UploadedDocument {
  readonly documentId: string;
  readonly documentVersionId: string;
}

export async function uploadBrainDocument(
  upload: BrainUpload,
  client: Platform = platform,
): Promise<UploadedDocument> {
  const { accessToken, brainId, idempotencyKey: key, mediaType, organizationId, sourceId } = upload;
  const bytes = Buffer.from(upload.contentBase64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > CONSOLE_BRAIN_UPLOAD_MAX_BYTES) {
    throw new TypeError("The file is empty or larger than the console uploads.");
  }
  const scope = { organizationId };
  const path = { brainId, sourceId };
  const issued = await client.callRoute(
    "createBrainUploadTicket",
    {
      body: decodeRequestBody("createBrainUploadTicket", "CreateBrainUploadTicketRequest", {
        expectedByteSize: bytes.byteLength,
        expectedContentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        mediaType,
      }),
      idempotencyKey: `${key}:ticket`,
      path,
      scope,
    },
    accessToken,
  );
  const ticketPath = { ...path, ticketId: issued.id };
  const readTicket = () =>
    client.callRoute("getBrainUploadTicket", { path: ticketPath, scope }, accessToken);
  let step = nextUploadStep(upload.retry ? await readTicket() : issued, new Date());
  if (step === "put") {
    try {
      await client.callRoute(
        "uploadBrainContent",
        {
          content: { bytes, contentType: mediaType },
          idempotencyKey: `${key}:content`,
          path: ticketPath,
          scope,
        },
        accessToken,
      );
      step = "capture";
    } catch (error) {
      const unanswered =
        error instanceof PlatformRequestError ||
        (error instanceof PlatformApiError && error.problem.status >= 500);
      if (!unanswered) throw error;
      step = nextUploadStep(await readTicket(), new Date()) === "capture" ? "capture" : "restart";
    }
  }
  if (step === "restart") {
    throw new PlatformApiError("uploadBrainContent", {
      code: BRAIN_UPLOAD_RESTART,
      status: 409,
      title: "Upload did not finish",
    });
  }
  const { document, version } = await client.callRoute(
    "captureBrainDocument",
    {
      body: decodeRequestBody("captureBrainDocument", "CaptureBrainDocumentRequest", {
        completedUploadTicketId: issued.id,
        externalItemIdentity: upload.externalItemIdentity,
        kind: "content",
        mediaType,
        ...(upload.title === undefined ? {} : { title: upload.title }),
      }),
      idempotencyKey: `${key}:capture`,
      path,
      scope,
    },
    accessToken,
  );
  return { documentId: document.id, documentVersionId: version.id };
}

export async function captureBrainLifecycle({
  accessToken,
  body,
  brainId,
  idempotencyKey,
  organizationId,
  sourceId,
}: BrainChange & {
  readonly body: unknown;
  readonly sourceId: string;
}): Promise<BrainDocumentView> {
  const capture = decodeRequestBody("captureBrainDocument", "CaptureBrainDocumentRequest", body);
  if (capture.kind === "content") {
    throw new TypeError("A content capture needs an upload; use uploadBrainDocument.");
  }
  return documentView(
    await callRoute(
      "captureBrainDocument",
      { body: capture, idempotencyKey, path: { brainId, sourceId }, scope: { organizationId } },
      accessToken,
    ),
  );
}

export async function resolveBrainReviewItem({
  accessToken,
  body,
  brainId,
  idempotencyKey,
  organizationId,
  reviewItemId,
}: BrainChange & {
  readonly body: unknown;
  readonly reviewItemId: string;
}): Promise<BrainReviewItemView> {
  return reviewItemView(
    await callRoute(
      "resolveBrainReviewItem",
      {
        body: decodeRequestBody("resolveBrainReviewItem", "ResolveBrainReviewItemRequest", body),
        idempotencyKey,
        path: { brainId, reviewItemId },
        scope: { organizationId },
      },
      accessToken,
    ),
  );
}
