import type { BrainUploadTicketResponse } from "@deployments-ai/api-contract/brains";
import {
  PlatformApiError,
  PlatformRequestError,
  type PlatformContext,
  type PlatformResponse,
  type PlatformSdk,
} from "./index.ts";

export interface UploadBrainContentInput {
  readonly bytes: Uint8Array;
  readonly context: PlatformContext;
  readonly idempotencyKey: string;
  readonly ticket: Pick<
    BrainUploadTicketResponse,
    "directUpload" | "mediaType" | "status" | "uploadPath"
  > & { readonly id: string };
}

/**
 * Stores the bytes an issued Brain upload ticket names and resolves the completed ticket. A ticket
 * that offers `directUpload` sends the bytes straight to storage and then completes, which carries
 * files the API's content PUT refuses: Lambda's 6 MB request payload holds about 4.5 MiB once the
 * body is base64-encoded. Resending after any failure, with the same idempotency key, converges.
 */
export async function uploadBrainContent(
  sdk: Pick<PlatformSdk, "request" | "uploadPresigned">,
  { bytes, context, idempotencyKey, ticket }: UploadBrainContentInput,
): Promise<PlatformResponse<BrainUploadTicketResponse>> {
  if (ticket.directUpload) {
    await sdk.uploadPresigned(ticket.directUpload, bytes).catch((error: unknown) => {
      // 412: an earlier attempt stored the object already, and completion verifies its checksum.
      if (!(error instanceof PlatformApiError && error.problem.status === 412)) throw error;
    });
    return sdk.request<BrainUploadTicketResponse>({
      context,
      idempotencyKey,
      method: "POST",
      path: ticket.directUpload.completePath,
    });
  }
  if (!ticket.uploadPath) {
    throw new PlatformRequestError(
      `Brain upload ticket ${ticket.id} is ${ticket.status} and accepts no content.`,
    );
  }
  return sdk.request<BrainUploadTicketResponse>({
    context,
    contentType: ticket.mediaType,
    idempotencyKey,
    method: "PUT",
    path: ticket.uploadPath,
    rawBody: bytes,
  });
}
