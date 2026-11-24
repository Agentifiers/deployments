import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  DELETE_ACCOUNT_PHRASE,
  isEmailAddress,
  isVerificationCode,
  type AccountProfile,
  type DeletionBlocker,
  type EmailChangeStarted,
} from "../../account/account-security.ts";
import {
  cancelEmailChangeFn,
  deleteAccountFn,
  requestEmailChangeFn,
} from "../../data/account-mutations.ts";
import {
  accountProfileQuery,
  accountSecurityQuery,
  invalidateAccount,
} from "../../data/account-queries.ts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Code, Text, TextLink } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { Timestamp } from "../observability/panels.tsx";

const DELETED_SIGN_OUT_FORM_ID = "account-deleted-sign-out";

/** The account is gone, so the console clears its session and returns to the start page. */
function DeletedSignOutForm() {
  return <form action="/auth/logout" hidden id={DELETED_SIGN_OUT_FORM_ID} method="post" />;
}

function leaveAfterDeletion() {
  document.forms.namedItem(DELETED_SIGN_OUT_FORM_ID)?.requestSubmit();
}

const MANAGER_NAME = { directory: "directory (SCIM)", "identity-provider": "identity provider" };

function ProveYourself({
  code,
  mfaOn,
  password,
  setCode,
  setPassword,
}: Readonly<{
  code: string;
  mfaOn: boolean;
  password: string;
  setCode: (value: string) => void;
  setPassword: (value: string) => void;
}>) {
  return (
    <>
      <Field>
        <Label>Password</Label>
        <Input
          autoComplete="current-password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </Field>
      {mfaOn ? (
        <Field>
          <Label>Code</Label>
          <Input
            autoCapitalize="characters"
            autoComplete="one-time-code"
            className="font-mono"
            name="code"
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
            value={code}
          />
          <Description>A code from your authenticator app, or an unused recovery code.</Description>
        </Field>
      ) : null}
    </>
  );
}

/** Password, plus a second-factor code when two-factor is on; valid only when both are present. */
function useProof() {
  const { data: security } = useSuspenseQuery(accountSecurityQuery());
  const mfaOn = security.mfa.state === "on";
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return {
    body: { password, ...(mfaOn ? { code } : {}) },
    fields: (
      <ProveYourself
        code={code}
        mfaOn={mfaOn}
        password={password}
        setCode={setCode}
        setPassword={setPassword}
      />
    ),
    ready: password !== "" && (!mfaOn || isVerificationCode(code)),
  };
}

function ChangeEmailDialog({
  current,
  onClose,
}: Readonly<{ current: string; onClose: () => void }>) {
  const queryClient = useQueryClient();
  const proof = useProof();
  const [newEmail, setNewEmail] = useState("");
  const same = newEmail.trim().toLowerCase() === current.toLowerCase();
  return (
    <ActionDialog<EmailChangeStarted>
      confirmLabel="Send confirmation link"
      description="We send a link to the new address. Your email changes only when you open it, within an hour. Then every session signs out, and we tell your current address how to report the change."
      invalid={!proof.ready || !isEmailAddress(newEmail) || same}
      onClose={onClose}
      onSuccess={() => void invalidateAccount(queryClient)}
      open
      runOnce={() => requestEmailChangeFn({ data: { ...proof.body, newEmail } })}
      successMessage={(started) => `Check ${started.email} for the confirmation link.`}
      title="Change email"
    >
      <Field>
        <Label>New email</Label>
        <Input
          autoComplete="email"
          name="newEmail"
          onChange={(event) => setNewEmail(event.target.value)}
          type="email"
          value={newEmail}
        />
        {same && newEmail ? <Description>That is already your email address.</Description> : null}
      </Field>
      {proof.fields}
    </ActionDialog>
  );
}

function EmailCard({
  open,
  profile,
}: Readonly<{ open: (dialog: LifecycleDialog) => void; profile: AccountProfile }>) {
  const { emailChange, pendingEmail } = profile;
  const description: ReactNode =
    emailChange.kind === "managed" ? (
      <>
        {emailChange.organizationName}'s {MANAGER_NAME[emailChange.managedBy]} manages this address.
        Ask that organization's administrators to change it.
      </>
    ) : emailChange.kind === "no-password" ? (
      "You sign in through an identity provider, which manages this address."
    ) : emailChange.kind === "held" && emailChange.reason === "reported" ? (
      <>
        An email change on this account was reported as one you did not make. You can change it
        again after <Timestamp value={emailChange.until} />.
      </>
    ) : emailChange.kind === "held" ? (
      <>
        Your email changed recently. You can change it again after{" "}
        <Timestamp value={emailChange.until} />, once your previous address can no longer report the
        change.
      </>
    ) : (
      "You sign in with this address, and security notices go to it."
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>{description}</CardDescription>
        {emailChange.kind === "available" ? (
          <CardAction>
            <Button onClick={() => open({ kind: "change-email" })} variant="outline">
              Change email
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <Text>
          <Code>{profile.email}</Code>
        </Text>
        {pendingEmail ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="pending" />
            <Text>
              Waiting for you to open the link sent to <Code>{pendingEmail.email}</Code>. It expires{" "}
              <Timestamp value={pendingEmail.expiresAt} />.
            </Text>
            <Button onClick={() => open({ kind: "cancel-email-change" })} variant="outline">
              Cancel change
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function blockerText(blocker: DeletionBlocker): ReactNode {
  switch (blocker.kind) {
    case "sole-owner":
      return (
        <>
          You are the only owner of {blocker.organizationName}.{" "}
          <TextLink href={`/o/${blocker.organizationId}/members`}>
            Make another member an owner
          </TextLink>{" "}
          or{" "}
          <TextLink href={`/o/${blocker.organizationId}/governance`}>
            erase the organization
          </TextLink>
          .
        </>
      );
    case "managed":
      return `${blocker.organizationName}'s ${MANAGER_NAME[blocker.managedBy]} manages your account. Ask that organization's administrators to remove you.`;
    case "platform-administrator":
      return "Platform administrators cannot delete their own account. Ask another administrator to remove your role first.";
    case "no-password":
      return "Your account has no password to confirm the deletion with.";
    case "held":
      return (
        <>
          Your email changed recently. You can delete your account after{" "}
          <Timestamp value={blocker.until} />, once your previous address can no longer report the
          change.
        </>
      );
    default: {
      const unhandled: never = blocker;
      return unhandled;
    }
  }
}

const DELETION_EFFECTS = [
  "Every browser, console, and CLI session signs out, and refresh tokens and device sign-ins stop working.",
  "You leave every organization you belong to. Their projects, agents, and audit history stay with them.",
  "Your name, email, password, and two-factor settings are removed, and the email address is free for a new account.",
  "We send a confirmation to your email address.",
];

function DeleteAccountDialog({
  onClose,
  profile,
}: Readonly<{ onClose: () => void; profile: AccountProfile }>) {
  const proof = useProof();
  const leaves = profile.deletion.kind === "allowed" ? profile.deletion.leaves : [];
  return (
    <ActionDialog
      confirmLabel="Delete account"
      confirmation={DELETE_ACCOUNT_PHRASE}
      description="This happens at once and cannot be undone."
      destructive
      invalid={!proof.ready}
      onClose={onClose}
      onSuccess={leaveAfterDeletion}
      open
      runOnce={() => deleteAccountFn({ data: proof.body })}
      successMessage="Your account was deleted."
      title="Delete your account"
    >
      {leaves.length > 0 ? (
        <Text>
          You leave {leaves.map((organization) => organization.organizationName).join(", ")}.
        </Text>
      ) : null}
      {proof.fields}
    </ActionDialog>
  );
}

function DeleteAccountCard({
  open,
  profile,
}: Readonly<{ open: (dialog: LifecycleDialog) => void; profile: AccountProfile }>) {
  const { deletion } = profile;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>Deleting your account is immediate and permanent.</CardDescription>
        {deletion.kind === "allowed" ? (
          <CardAction>
            <Button onClick={() => open({ kind: "delete-account" })} variant="destructive">
              Delete account
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {DELETION_EFFECTS.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
        {deletion.kind === "blocked" ? (
          <Callout variant="destructive">
            <CalloutTitle>You cannot delete your account yet</CalloutTitle>
            <CalloutDescription>
              <ul className="list-disc space-y-1 pl-5">
                {deletion.blockers.map((blocker) => (
                  <li key={"organizationId" in blocker ? blocker.organizationId : blocker.kind}>
                    {blockerText(blocker)}
                  </li>
                ))}
              </ul>
            </CalloutDescription>
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}

type LifecycleDialog =
  | { readonly kind: "cancel-email-change" }
  | { readonly kind: "change-email" }
  | { readonly kind: "delete-account" };

function LifecycleDialogs({
  dialog,
  onClose,
  profile,
}: Readonly<{
  dialog: LifecycleDialog | undefined;
  onClose: () => void;
  profile: AccountProfile;
}>) {
  const queryClient = useQueryClient();
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "change-email":
      return <ChangeEmailDialog current={profile.email} onClose={onClose} />;
    case "cancel-email-change":
      return (
        <ActionDialog
          confirmLabel="Cancel change"
          description="The link sent to the new address stops working. Your email stays as it is."
          onClose={onClose}
          onSuccess={() => void invalidateAccount(queryClient)}
          open
          runOnce={() => cancelEmailChangeFn()}
          successMessage="Email change canceled."
          title="Cancel the email change"
        />
      );
    case "delete-account":
      return <DeleteAccountDialog onClose={onClose} profile={profile} />;
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}

/** The email card, which sits first on the account page. */
export function AccountEmail() {
  const { data: profile } = useSuspenseQuery(accountProfileQuery());
  const [dialog, setDialog] = useState<LifecycleDialog>();
  return (
    <>
      <EmailCard open={setDialog} profile={profile} />
      <LifecycleDialogs dialog={dialog} onClose={() => setDialog(undefined)} profile={profile} />
    </>
  );
}

/** The account deletion card, which sits last on the account page. */
export function AccountDeletion() {
  const { data: profile } = useSuspenseQuery(accountProfileQuery());
  const [dialog, setDialog] = useState<LifecycleDialog>();
  return (
    <>
      <DeleteAccountCard open={setDialog} profile={profile} />
      <DeletedSignOutForm />
      <LifecycleDialogs dialog={dialog} onClose={() => setDialog(undefined)} profile={profile} />
    </>
  );
}
