/** What the account page shows, as the identity service's `/v1/account/` routes return it. */
export interface AccountSecurity {
  readonly mfa:
    | { readonly state: "off" }
    | {
        readonly activatedAt: string;
        readonly recoveryCodesRemaining: number;
        readonly state: "on";
      };
  /** False for an account that only signs in through its organization's identity provider. */
  readonly passwordSignIn: boolean;
}

export interface AccountSession {
  readonly authenticationTime: string;
  readonly createdAt: string;
  /** The browser session this console session was signed in from. */
  readonly current: boolean;
  /** A coarse label such as "Chrome on macOS"; sessions signed in before identity kept it lack one. */
  readonly deviceLabel?: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly idleExpiresAt: string;
  readonly lastRefreshedAt: string;
}

export interface AccountSessionPage {
  readonly items: readonly AccountSession[];
  readonly nextCursor?: string;
}

export interface MfaEnrollment {
  readonly otpauthUri: string;
  readonly secret: string;
}

export interface RecoveryCodes {
  readonly recoveryCodes: readonly string[];
}

/** Identity enforces the same rule; checking here keeps the button honest. */
export const MINIMUM_PASSWORD_LENGTH = 15;

export function passwordChangeProblem(input: {
  readonly confirmation: string;
  readonly current: string;
  readonly next: string;
}): string | undefined {
  if (!input.current || !input.next) return "Enter your current and new password.";
  if (Array.from(input.next).length < MINIMUM_PASSWORD_LENGTH) {
    return `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
  }
  if (input.next !== input.confirmation) return "The new passwords do not match.";
  if (input.next === input.current) return "Choose a password you are not using now.";
  return undefined;
}

/** A six-digit authenticator code or a 16-character recovery code, ignoring spaces and dashes. */
export function isVerificationCode(input: string): boolean {
  const compact = input.replaceAll(/[\s-]/gu, "");
  return /^\d{6}$/u.test(compact) || /^[A-Za-z2-7]{16}$/u.test(compact);
}

/** An organization named on the account page, as identity reports it. */
export interface AccountOrganization {
  readonly organizationId: string;
  readonly organizationName: string;
}

/** Who keeps a managed person's email in step: the organization's IdP or its SCIM directory. */
export type AccountManager = "directory" | "identity-provider";

export type EmailChangeAvailability =
  | { readonly kind: "available" }
  | ({ readonly kind: "managed"; readonly managedBy: AccountManager } & AccountOrganization)
  /** `changed`: the old address can still report a change; `reported`: a change was reported. */
  | { readonly kind: "held"; readonly reason: "changed" | "reported"; readonly until: string }
  | { readonly kind: "no-password" };

export type DeletionBlocker =
  | ({ readonly kind: "sole-owner" } & AccountOrganization)
  | ({ readonly kind: "managed"; readonly managedBy: AccountManager } & AccountOrganization)
  | { readonly kind: "platform-administrator" }
  | { readonly kind: "no-password" }
  | { readonly kind: "held"; readonly until: string };

/** The person's email and whether the account can be deleted, from `/v1/account/profile`. */
export interface AccountProfile {
  readonly deletion:
    | { readonly kind: "allowed"; readonly leaves: readonly AccountOrganization[] }
    | { readonly kind: "blocked"; readonly blockers: readonly DeletionBlocker[] };
  readonly email: string;
  readonly emailChange: EmailChangeAvailability;
  readonly pendingEmail?: { readonly email: string; readonly expiresAt: string };
}

export interface EmailChangeStarted {
  readonly email: string;
  readonly expiresAt: string;
}

/** The phrase typed to confirm deleting the account. */
export const DELETE_ACCOUNT_PHRASE = "delete my account";

/** A plausible address; identity normalizes and checks it again. */
export function isEmailAddress(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.trim());
}
