import type {
  IdentityRecord,
  IdentityRepository,
  OrganizationInvitationEmailContext,
  PendingFederationLink,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { renderIdentityEmail } from "@deployments-ai/identity-emails";
import { timingSafeEqual } from "node:crypto";
import { linkedActionIsUsable, usableFederationLink } from "./action-validity.ts";
import { emailChangeContent } from "./email-change-message.ts";

/** Decrypted protected payload of any identity email delivery. */
export interface IdentityEmailPayload {
  readonly actionToken?: string;
  readonly recipient: string;
  readonly schemaVersion: 1;
}

export interface RenderedIdentityEmail {
  readonly html: string;
  readonly subject: string;
  readonly text: string;
}

export type IdentityEmailMessage =
  | { readonly kind: "discard"; readonly failureCategory: "linked-action-invalid" }
  | {
      readonly content: RenderedIdentityEmail;
      readonly kind: "send";
      readonly recipient: string;
    };

export interface IdentityEmailMessageDependencies {
  /** Browser application origin without a trailing slash; hosts invitation acceptance. */
  readonly applicationOrigin: string;
  readonly invitationForEmail: (
    organizationId: string,
    invitationId: string,
  ) => Promise<OrganizationInvitationEmailContext | undefined>;
  /** Identity issuer origin without a trailing slash; hosts verify, reset, and link-confirm pages. */
  readonly issuer: string;
  readonly pendingFederationLink: (
    token: string,
    now: Date,
  ) => Promise<PendingFederationLink | undefined>;
  readonly repository: IdentityRepository;
}

const DISCARD: IdentityEmailMessage = { failureCategory: "linked-action-invalid", kind: "discard" };

function requiredActionToken(payload: IdentityEmailPayload) {
  if (!payload.actionToken) throw new Error("Identity action email has no action token.");
  return payload.actionToken;
}

function tokenMatchesHash(token: string, tokenHash: string) {
  const actual = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function invitationMessage(
  delivery: IdentityRecord<"identity-email-delivery">,
  payload: IdentityEmailPayload,
  dependencies: IdentityEmailMessageDependencies,
  now: Date,
): Promise<IdentityEmailMessage> {
  const { invitationId, organizationId, principalId } = delivery.data;
  const token = payload.actionToken;
  if (!invitationId || !organizationId || !token) return DISCARD;
  const context = await dependencies.invitationForEmail(organizationId, invitationId);
  const invitation = context?.invitation.data;
  if (
    !context ||
    !invitation ||
    invitation.status !== "pending" ||
    Date.parse(invitation.expiresAt) <= now.getTime() ||
    invitation.invitedByPrincipalId !== principalId ||
    invitation.email !== payload.recipient ||
    !tokenMatchesHash(token, invitation.tokenHash)
  ) {
    return DISCARD;
  }
  const inviter = context.inviter?.data;
  return {
    content: await renderIdentityEmail({
      actionUrl: `${dependencies.applicationOrigin}/invitations/accept?invitation=${encodeURIComponent(invitation.id)}&token=${encodeURIComponent(token)}`,
      expiresAt: invitation.expiresAt,
      inviterName: inviter?.displayName?.trim() || inviter?.primaryEmail || "A teammate",
      organizationName: context.organization.data.name,
      purpose: "organization-invitation",
      role: invitation.role,
    }),
    kind: "send",
    recipient: payload.recipient,
  };
}

async function federationLinkMessage(
  delivery: IdentityRecord<"identity-email-delivery">,
  payload: IdentityEmailPayload,
  dependencies: IdentityEmailMessageDependencies,
  now: Date,
): Promise<IdentityEmailMessage> {
  const token = payload.actionToken;
  if (!token) return DISCARD;
  const link = await usableFederationLink({
    delivery,
    link: await dependencies.pendingFederationLink(token, now),
    recipient: payload.recipient,
    repository: dependencies.repository,
  });
  if (!link) return DISCARD;
  return {
    content: await renderIdentityEmail({
      actionUrl: `${dependencies.issuer}/federation/confirm-link#token=${encodeURIComponent(token)}`,
      expiresAt: link.expiresAt,
      identityProvider: link.identityProvider,
      organizationName: link.organizationName,
      purpose: "federated-identity-link",
    }),
    kind: "send",
    recipient: payload.recipient,
  };
}

/**
 * Revalidates the delivery's linked action, invitation, or federation link request and renders its
 * message. Anything no longer usable is discarded rather than sent; the plaintext token only
 * reaches the rendered link.
 */
export async function identityEmailMessage(
  delivery: IdentityRecord<"identity-email-delivery">,
  payload: IdentityEmailPayload,
  dependencies: IdentityEmailMessageDependencies,
  now: Date,
): Promise<IdentityEmailMessage> {
  const purpose = delivery.data.purpose;
  if (purpose === "organization-invitation") {
    return invitationMessage(delivery, payload, dependencies, now);
  }
  if (purpose === "federated-identity-link") {
    return federationLinkMessage(delivery, payload, dependencies, now);
  }
  if (purpose === "email-change-verify" || purpose === "email-changed") {
    const content = await emailChangeContent({
      ...(payload.actionToken ? { actionToken: payload.actionToken } : {}),
      delivery,
      issuer: dependencies.issuer,
      now,
      purpose,
      recipient: payload.recipient,
      repository: dependencies.repository,
    });
    return content ? { content, kind: "send", recipient: payload.recipient } : DISCARD;
  }
  if (
    !(await linkedActionIsUsable({
      ...(payload.actionToken ? { actionToken: payload.actionToken } : {}),
      delivery,
      now,
      recipient: payload.recipient,
      repository: dependencies.repository,
    }))
  ) {
    return DISCARD;
  }
  const content =
    purpose === "verify-email"
      ? await renderIdentityEmail({
          actionUrl: `${dependencies.issuer}/verify#verify=${encodeURIComponent(requiredActionToken(payload))}`,
          purpose,
        })
      : purpose === "reset-password"
        ? await renderIdentityEmail({
            actionUrl: `${dependencies.issuer}/reset-password#reset=${encodeURIComponent(requiredActionToken(payload))}`,
            purpose,
          })
        : await renderIdentityEmail({ purpose });
  return { content, kind: "send", recipient: payload.recipient };
}
