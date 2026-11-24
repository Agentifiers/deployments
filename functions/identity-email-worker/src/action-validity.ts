import type { IdentityRecord, IdentityRepository, PendingFederationLink } from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";

export async function linkedActionIsUsable(input: {
  readonly actionToken?: string;
  readonly delivery: IdentityRecord<"identity-email-delivery">;
  readonly now: Date;
  readonly recipient: string;
  readonly repository: IdentityRepository;
}) {
  const { delivery } = input;
  if (delivery.data.purpose !== "verify-email" && delivery.data.purpose !== "reset-password") {
    return true;
  }
  if (!delivery.data.actionId || !input.actionToken) return false;
  const action = await input.repository.identityActionForHash(sha256(input.actionToken));
  if (
    !action ||
    action.data.id !== delivery.data.actionId ||
    action.data.principalId !== delivery.data.principalId ||
    action.data.purpose !== delivery.data.purpose ||
    action.data.status !== "pending" ||
    Date.parse(action.data.expiresAt) <= input.now.getTime()
  ) {
    return false;
  }
  if (action.data.purpose === "verify-email") {
    if (
      !action.data.targetEmail ||
      !action.data.targetEmailHash ||
      action.data.targetEmail !== input.recipient
    ) {
      return false;
    }
    const [registration, principal] = await Promise.all([
      input.repository.registrationForEmailHash(action.data.targetEmailHash),
      input.repository.principalForEmailHash(action.data.targetEmailHash),
    ]);
    return (
      !principal &&
      registration?.data.id === action.data.principalId &&
      registration.data.email === action.data.targetEmail &&
      Date.parse(registration.data.expiresAt) > input.now.getTime()
    );
  }
  const [material, fence] = await Promise.all([
    input.repository.loadLoginMaterial(action.data.principalId),
    input.repository.bffFenceForPrincipal(action.data.principalId),
  ]);
  return (
    material.principal?.data.status === "active" &&
    material.principal.data.kind === "human" &&
    material.principal.data.primaryEmail === input.recipient &&
    material.credential?.data.status === "active" &&
    material.securityState?.data.emailVerifiedAt !== undefined &&
    action.data.issuedCredentialVersion === material.securityState.data.credentialVersion &&
    fence?.data.principalStatus === "active" &&
    fence.data.sessionEpoch === material.securityState.data.sessionEpoch
  );
}

export async function usableFederationLink(input: {
  readonly delivery: IdentityRecord<"identity-email-delivery">;
  readonly link: PendingFederationLink | undefined;
  readonly recipient: string;
  readonly repository: IdentityRepository;
}) {
  const { link } = input;
  if (link?.principalId !== input.delivery.data.principalId) return undefined;
  const principal = await input.repository.principalForId(link.principalId);
  return principal?.data.status === "active" &&
    principal.data.kind === "human" &&
    principal.data.primaryEmail === input.recipient
    ? link
    : undefined;
}
