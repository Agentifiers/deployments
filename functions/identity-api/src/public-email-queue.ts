import type { Ulid } from "@deployments-ai/db";
import { normalizeEmail } from "@deployments-ai/identity";
import type { PublicEmailRequest, QueuedPublicEmailRequest } from "./public-email-requests.ts";

export function makePublicEmailRequestQueue(input: {
  readonly generateId: () => Ulid;
  readonly send: (body: string) => Promise<void>;
}) {
  return async (request: QueuedPublicEmailRequest) => {
    const email = normalizeEmail(request.email);
    const message: PublicEmailRequest = {
      email,
      operation: request.operation,
      requestId: input.generateId(),
      schemaVersion: 1,
      ...(request.sourcePrefixHash ? { sourcePrefixHash: request.sourcePrefixHash } : {}),
    };
    await input.send(JSON.stringify(message));
  };
}
