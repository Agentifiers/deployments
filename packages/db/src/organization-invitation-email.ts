import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import {
  identityEmailDeliveryBinding,
  identityEmailDeliveryShard,
  pendingEmailDeliveryRecord,
} from "./identity/record-builders.ts";
import type { Ulid } from "./ids.ts";
import { key } from "./keys.ts";
import type {
  InvitationEmailDependency,
  Organization,
  OrganizationInvitation,
  Principal,
} from "./tenancy-contracts.ts";

/** Decrypted protected payload of an `organization-invitation` identity email delivery. */
export interface OrganizationInvitationEmailPayload {
  readonly actionToken: string;
  readonly recipient: string;
  readonly schemaVersion: 1;
}

/** Control-table records the invitation email worker revalidates and renders from. */
export interface OrganizationInvitationEmailContext {
  readonly invitation: OrganizationInvitation;
  readonly inviter: Principal | undefined;
  readonly organization: Organization;
}

/**
 * Builds the pending outbox put for a newly created invitation. The plaintext token and invitee
 * address exist only inside the envelope, bound to the delivery and invitation IDs, so the put
 * must commit in the invitation's own transaction.
 */
export async function organizationInvitationEmailDelivery(input: {
  readonly deliveryId: Ulid;
  readonly encryptPayload: InvitationEmailDependency["encryptPayload"];
  readonly invitation: OrganizationInvitation;
  readonly token: string;
}): Promise<TransactionOperation> {
  const invitation = input.invitation.data;
  const purpose = "organization-invitation" as const;
  const payload: OrganizationInvitationEmailPayload = {
    actionToken: input.token,
    recipient: invitation.email,
    schemaVersion: 1,
  };
  const protectedPayload = await input.encryptPayload(
    payload,
    identityEmailDeliveryBinding({ id: input.deliveryId, invitationId: invitation.id, purpose }),
  );
  return {
    kind: "put",
    record: pendingEmailDeliveryRecord({
      createdAt: invitation.createdAt,
      dispatchShard: identityEmailDeliveryShard(input.deliveryId),
      expiresAt: invitation.expiresAt,
      id: input.deliveryId,
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      principalId: invitation.invitedByPrincipalId,
      protectedPayload,
      purpose,
    }),
  };
}

/** Strongly consistent invitation, organization, and inviter reads for invitation email delivery. */
export async function organizationInvitationForEmail(
  database: DynamoDatabaseService,
  organizationId: string,
  invitationId: string,
): Promise<OrganizationInvitationEmailContext | undefined> {
  const organizationKey = key("ORG", organizationId);
  const [invitation, organization] = await Promise.all([
    database.getRecord(
      "control",
      { pk: organizationKey, sk: key("ORGANIZATION-INVITATION", invitationId) },
      true,
    ),
    database.getRecord("control", { pk: organizationKey, sk: organizationKey }, true),
  ]);
  if (
    invitation?.itemType !== "organization-invitation" ||
    organization?.itemType !== "organization"
  ) {
    return undefined;
  }
  const principalKey = key("PRINCIPAL", invitation.data.invitedByPrincipalId);
  const principal = await database.getRecord(
    "control",
    { pk: principalKey, sk: principalKey },
    true,
  );
  return {
    invitation,
    inviter: principal?.itemType === "principal" ? principal : undefined,
    organization,
  };
}
