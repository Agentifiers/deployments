import { render } from "react-email";
import { AlertEmail, alertEmailSubject, type AlertEmailProps } from "./emails/alert.tsx";
import {
  FederatedIdentityLink,
  type FederatedIdentityLinkProps,
} from "./emails/federated-identity-link.tsx";
import {
  OrganizationInvitation,
  type OrganizationInvitationProps,
} from "./emails/organization-invitation.tsx";
import { AccountDeleted } from "./emails/account-deleted.tsx";
import { EmailChangeVerify, type EmailChangeVerifyProps } from "./emails/email-change-verify.tsx";
import { EmailChangeReported } from "./emails/email-change-reported.tsx";
import { EmailChanged, type EmailChangedProps } from "./emails/email-changed.tsx";
import { MfaChanged } from "./emails/mfa-changed.tsx";
import { PasswordChanged } from "./emails/password-changed.tsx";
import { RefreshReuse } from "./emails/refresh-reuse.tsx";
import { ResetPassword } from "./emails/reset-password.tsx";
import { VerifyEmail } from "./emails/verify-email.tsx";

export type IdentityEmailRenderInput =
  | {
      readonly actionUrl: string;
      readonly purpose: "reset-password" | "verify-email";
    }
  | {
      readonly actionUrl?: never;
      readonly purpose:
        | "account-deleted"
        | "email-change-reported"
        | "mfa-disabled"
        | "mfa-enabled"
        | "password-changed"
        | "suspicious-refresh-reuse";
    }
  | (OrganizationInvitationProps & { readonly purpose: "organization-invitation" })
  | (FederatedIdentityLinkProps & { readonly purpose: "federated-identity-link" })
  | (EmailChangeVerifyProps & { readonly purpose: "email-change-verify" })
  | (EmailChangedProps & { readonly purpose: "email-changed" });

function identityEmail(input: IdentityEmailRenderInput) {
  switch (input.purpose) {
    case "verify-email":
      return {
        subject: "Verify your Deployments.ai email",
        template: <VerifyEmail actionUrl={input.actionUrl} />,
      };
    case "reset-password":
      return {
        subject: "Reset your Deployments.ai password",
        template: <ResetPassword actionUrl={input.actionUrl} />,
      };
    case "password-changed":
      return { subject: "Your Deployments.ai password changed", template: <PasswordChanged /> };
    case "mfa-enabled":
      return {
        subject: "Two-factor authentication is on for your Deployments.ai account",
        template: <MfaChanged change="enabled" />,
      };
    case "mfa-disabled":
      return {
        subject: "Two-factor authentication is off for your Deployments.ai account",
        template: <MfaChanged change="disabled" />,
      };
    case "email-change-verify":
      return {
        subject: "Confirm your new Deployments.ai email address",
        template: <EmailChangeVerify actionUrl={input.actionUrl} expiresAt={input.expiresAt} />,
      };
    case "email-changed":
      return {
        subject: "Your Deployments.ai email address changed",
        template: (
          <EmailChanged
            actionUrl={input.actionUrl}
            expiresAt={input.expiresAt}
            newEmail={input.newEmail}
          />
        ),
      };
    case "email-change-reported":
      return {
        subject: "An email change on Deployments.ai was reported",
        template: <EmailChangeReported />,
      };
    case "account-deleted":
      return { subject: "Your Deployments.ai account was deleted", template: <AccountDeleted /> };
    case "suspicious-refresh-reuse":
      return { subject: "Deployments.ai security alert", template: <RefreshReuse /> };
    case "organization-invitation":
      return {
        subject: `${input.inviterName} invited you to ${input.organizationName} on Deployments.ai`,
        template: (
          <OrganizationInvitation
            actionUrl={input.actionUrl}
            expiresAt={input.expiresAt}
            inviterName={input.inviterName}
            organizationName={input.organizationName}
            role={input.role}
          />
        ),
      };
    case "federated-identity-link":
      return {
        subject: `Confirm your ${input.organizationName} sign-in connection on Deployments.ai`,
        template: (
          <FederatedIdentityLink
            actionUrl={input.actionUrl}
            expiresAt={input.expiresAt}
            identityProvider={input.identityProvider}
            organizationName={input.organizationName}
          />
        ),
      };
  }
}

export async function renderIdentityEmail(input: IdentityEmailRenderInput) {
  const { subject, template } = identityEmail(input);
  const [html, text] = await Promise.all([render(template), render(template, { plainText: true })]);
  return { html, subject, text };
}

/** Renders one alert notification; the subject names the state and the monitor. */
export async function renderAlertEmail(props: AlertEmailProps) {
  const template = <AlertEmail {...props} />;
  const [html, text] = await Promise.all([render(template), render(template, { plainText: true })]);
  return { html, subject: alertEmailSubject(props), text };
}
