import {
  publicEmailRequestRecord,
  type IdentityRecord,
  type IdentityRepository,
  type Ulid,
} from "@deployments-ai/db";
import { plusSeconds } from "./time-arithmetic.ts";

const PUBLIC_EMAIL_DEDUPLICATION_SECONDS = 30 * 24 * 60 * 60;

export function makePublicEmailRequestMarker(
  requestId: Ulid | undefined,
  operation: "password-recovery" | "sign-up",
  timestamp: Date,
) {
  return requestId
    ? publicEmailRequestRecord({
        createdAt: timestamp.toISOString(),
        expiresAt: plusSeconds(timestamp, PUBLIC_EMAIL_DEDUPLICATION_SECONDS),
        id: requestId,
        operation,
      })
    : undefined;
}

export async function publicEmailRequestWasProcessed(
  repository: IdentityRepository,
  requestId: Ulid,
  timestamp: Date,
) {
  const marker = await repository.publicEmailRequestForId(requestId);
  return Boolean(marker && Date.parse(marker.data.expiresAt) > timestamp.getTime());
}

export async function commitPublicEmailNoop(
  repository: IdentityRepository,
  marker: IdentityRecord<"identity-public-email-request"> | undefined,
  timestamp: Date,
) {
  if (!marker) return;
  try {
    await repository.transact([{ kind: "put", record: marker }]);
  } catch (error) {
    if (await publicEmailRequestWasProcessed(repository, marker.data.id, timestamp)) {
      return;
    }
    throw error;
  }
}
