import type { IdentityRecord, IdentityRepository } from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { renderIdentityEmail } from "@deployments-ai/identity-emails";
import { timingSafeEqual } from "node:crypto";

type Delivery = IdentityRecord<"identity-email-delivery">;

function secretMatches(secret: string, tokenHash: string) {
  const actual = Buffer.from(sha256(secret), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Link tokens are `<principalId>.<secret>`; only the secret's hash is stored on the change. */
function linkSecret(delivery: Delivery, token: string | undefined) {
  if (!token) return undefined;
  const separator = token.indexOf(".");
  return separator > 0 && token.slice(0, separator) === delivery.data.principalId
    ? token.slice(separator + 1)
    : undefined;
}

/**
 * Renders an email change message only while the change it describes still stands. A request a
 * newer one replaced, cancelled, expired, or voided by a password change sends nothing, and the
 * notice to the old address only goes out while the change can still be reported.
 */
export async function emailChangeContent(input: {
  readonly actionToken?: string;
  readonly delivery: Delivery;
  readonly issuer: string;
  readonly now: Date;
  readonly purpose: "email-change-verify" | "email-changed";
  readonly recipient: string;
  readonly repository: IdentityRepository;
}) {
  const { delivery, now, recipient, repository } = input;
  const secret = linkSecret(delivery, input.actionToken);
  if (!secret || !input.actionToken) return undefined;
  const [record, material] = await Promise.all([
    repository.emailChangeForPrincipal(delivery.data.principalId),
    repository.loadLoginMaterial(delivery.data.principalId),
  ]);
  const change = record?.data;
  if (material.principal?.data.status !== "active" || !material.securityState) return undefined;
  const fragment = `#token=${encodeURIComponent(input.actionToken)}`;
  if (input.purpose === "email-change-verify") {
    if (
      change?.state !== "pending" ||
      change.newEmail !== recipient ||
      change.credentialVersion !== material.securityState.data.credentialVersion ||
      Date.parse(change.expiresAt) <= now.getTime() ||
      !secretMatches(secret, change.tokenHash)
    ) {
      return undefined;
    }
    return renderIdentityEmail({
      actionUrl: `${input.issuer}/email-change/confirm${fragment}`,
      expiresAt: change.expiresAt,
      purpose: "email-change-verify",
    });
  }
  if (
    change?.state !== "applied" ||
    change.previousEmail !== recipient ||
    Date.parse(change.reportExpiresAt) <= now.getTime() ||
    !secretMatches(secret, change.reportTokenHash)
  ) {
    return undefined;
  }
  return renderIdentityEmail({
    actionUrl: `${input.issuer}/email-change/report${fragment}`,
    expiresAt: change.reportExpiresAt,
    newEmail: change.newEmail,
    purpose: "email-changed",
  });
}
