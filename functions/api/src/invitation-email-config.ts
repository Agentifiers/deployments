import { makeKmsEnvelopeAdapter, type InvitationEmailDependency } from "@deployments-ai/db";
import type { KMSClient } from "@aws-sdk/client-kms";

export const INVITATION_EMAIL_ENV = {
  identityEmailKmsKeyId: "DEPLOYMENTS_AI_IDENTITY_EMAIL_KMS_KEY_ID",
  stage: "DEPLOYMENTS_AI_STAGE",
} as const;

/**
 * Invitation email is enabled when the identity email key is configured (platform identity
 * deployed). Without it, invitations return their one-time token without queueing an email.
 */
export function invitationEmailFromEnvironment(
  environment: NodeJS.ProcessEnv,
  kms?: KMSClient,
): InvitationEmailDependency | undefined {
  const keyId = environment[INVITATION_EMAIL_ENV.identityEmailKmsKeyId]?.trim();
  if (!keyId) return undefined;
  const stage = environment[INVITATION_EMAIL_ENV.stage]?.trim();
  if (!stage) {
    throw new Error(
      `${INVITATION_EMAIL_ENV.stage} is required when ${INVITATION_EMAIL_ENV.identityEmailKmsKeyId} is configured.`,
    );
  }
  const envelope = makeKmsEnvelopeAdapter({ keyId, ...(kms ? { kms } : {}), stage });
  return { encryptPayload: envelope.encrypt };
}
