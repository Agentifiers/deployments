import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useRef, useState, type ReactNode } from "react";
import {
  isVerificationCode,
  passwordChangeProblem,
  type MfaEnrollment,
  type RecoveryCodes,
} from "../../account/account-security.ts";
import {
  beginMfaEnrollmentFn,
  changeAccountPasswordFn,
  confirmMfaEnrollmentFn,
  disableMfaFn,
  regenerateRecoveryCodesFn,
  revokeAccountSessionFn,
  signOutEverywhereFn,
} from "../../data/account-mutations.ts";
import { invalidateAccount } from "../../data/account-queries.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Code } from "@/components/ui/text";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
} from "@/components/reui/stepper";
import { ActionDialog } from "../action-dialog.tsx";
import { CopyField } from "../copy-field.tsx";
import { Icon } from "../icon.tsx";
import { OtpauthQrCode } from "./otpauth-qr.tsx";

export type AccountDialog =
  | { readonly kind: "change-password" }
  | { readonly kind: "disable-mfa" }
  | { readonly kind: "enroll-mfa" }
  | { readonly kind: "regenerate-codes" }
  | { readonly kind: "revoke-session"; readonly sessionId: string }
  | { readonly kind: "sign-out-everywhere" };

export const ACCOUNT_SIGN_OUT_FORM_ID = "account-sign-out";

/**
 * Changing the password, signing out everywhere, or revoking this browser's session ends the
 * console session too, so the console clears its own session and opens a fresh sign-in.
 */
export function AccountSignOutForm() {
  return (
    <form action="/auth/logout" hidden id={ACCOUNT_SIGN_OUT_FORM_ID} method="post">
      <input name="prompt" type="hidden" value="login" />
      <input name="returnTo" type="hidden" value="/account" />
    </form>
  );
}

function leaveForSignIn() {
  document.forms.namedItem(ACCOUNT_SIGN_OUT_FORM_ID)?.requestSubmit();
}

/**
 * `ActionDialog` closes after its success callback; a step that leads to another step keeps the
 * flow open by marking the success first.
 */
function useStepClose(onClose: () => void) {
  const advancing = useRef(false);
  return {
    advance: () => {
      advancing.current = true;
    },
    closeStep: () => {
      if (advancing.current) advancing.current = false;
      else onClose();
    },
  };
}

function PasswordField({
  autoComplete,
  label,
  name,
  onChange,
  value,
}: Readonly<{
  autoComplete: "current-password" | "new-password";
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}>) {
  return (
    <Field>
      <Label>{label}</Label>
      <Input
        autoComplete={autoComplete}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        type="password"
        value={value}
      />
    </Field>
  );
}

function CodeField({
  description,
  onChange,
  value,
}: Readonly<{ description: string; onChange: (value: string) => void; value: string }>) {
  return (
    <Field>
      <Label>Code</Label>
      <Input
        autoCapitalize="characters"
        autoComplete="one-time-code"
        className="font-mono"
        name="code"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
      <Description>{description}</Description>
    </Field>
  );
}

function ChangePasswordDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const problem = passwordChangeProblem({ confirmation, current, next });
  return (
    <ActionDialog
      confirmLabel="Change password"
      description="Every session ends, including this one, and you sign in again with the new password. We email you that it changed."
      invalid={problem !== undefined}
      onClose={onClose}
      onSuccess={leaveForSignIn}
      open
      runOnce={() =>
        changeAccountPasswordFn({ data: { currentPassword: current, password: next } })
      }
      successMessage="Password changed. Sign in with the new password."
      title="Change password"
    >
      <PasswordField
        autoComplete="current-password"
        label="Current password"
        name="currentPassword"
        onChange={setCurrent}
        value={current}
      />
      <PasswordField
        autoComplete="new-password"
        label="New password"
        name="password"
        onChange={setNext}
        value={next}
      />
      <PasswordField
        autoComplete="new-password"
        label="Confirm new password"
        name="confirmation"
        onChange={setConfirmation}
        value={confirmation}
      />
      {problem && next ? <Description>{problem}</Description> : null}
    </ActionDialog>
  );
}

const ENROLL_STEPS = ["Password", "Authenticator", "Recovery codes"] as const;

/**
 * Where turning on two-factor stands. A progress list, not ReUI's tablist: the steps are not
 * buttons, since each one is its own dialog that only the previous step's success opens.
 */
function EnrollSteps({ current }: Readonly<{ current: 1 | 2 | 3 }>) {
  return (
    <Stepper
      aria-label="Two-factor setup"
      aria-orientation={undefined}
      className="flex items-center gap-2"
      indicators={{ completed: <Icon className="size-3.5" icon={Tick02Icon} /> }}
      role="list"
      value={current}
    >
      {ENROLL_STEPS.map((title, index) => {
        const step = index + 1;
        return (
          <StepperItem
            aria-current={step === current ? "step" : undefined}
            className="gap-2"
            key={title}
            role="listitem"
            step={step}
          >
            <StepperIndicator>{step}</StepperIndicator>
            <span
              className={cn(
                "text-sm font-medium whitespace-nowrap group-data-[state=inactive]/step:text-muted-foreground",
                step === current ? undefined : "max-sm:sr-only",
              )}
            >
              {title}
            </span>
            {step < ENROLL_STEPS.length ? (
              <StepperSeparator className="h-0.5 flex-1 data-[state=completed]:bg-primary" />
            ) : null}
          </StepperItem>
        );
      })}
    </Stepper>
  );
}

function RecoveryCodesDialog({
  codes,
  onDone,
  progress,
}: Readonly<{ codes: readonly string[]; onDone: () => void; progress?: ReactNode }>) {
  const [stored, setStored] = useState(false);
  return (
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Store your recovery codes</DialogTitle>
          <DialogDescription>
            Each code signs you in once if you lose your authenticator. The console shows them only
            now.
          </DialogDescription>
        </DialogHeader>
        {progress}
        <ol className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <CopyField label="Recovery codes" value={codes.join(" ")} />
        <CheckboxField>
          <Checkbox checked={stored} onCheckedChange={(checked) => setStored(checked)} />
          <Label>I stored these recovery codes</Label>
        </CheckboxField>
        <DialogFooter>
          <Button disabled={!stored} onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Password, then the secret and a code from the app, then the recovery codes, in one dialog. */
function EnrollMfaDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<MfaEnrollment>();
  const [issued, setIssued] = useState<RecoveryCodes>();
  const { advance, closeStep } = useStepClose(onClose);
  if (issued) {
    return (
      <RecoveryCodesDialog
        codes={issued.recoveryCodes}
        onDone={() => {
          void invalidateAccount(queryClient);
          onClose();
        }}
        progress={<EnrollSteps current={3} />}
      />
    );
  }
  if (!enrollment) {
    return (
      <ActionDialog<MfaEnrollment>
        confirmLabel="Continue"
        description="Confirm your password to set up an authenticator app."
        invalid={!password}
        onClose={closeStep}
        onSuccess={(result) => {
          advance();
          setEnrollment(result);
        }}
        open
        runOnce={() => beginMfaEnrollmentFn({ data: { password } })}
        successMessage="Add the account to your authenticator app."
        title="Turn on two-factor authentication"
      >
        <EnrollSteps current={1} />
        <PasswordField
          autoComplete="current-password"
          label="Password"
          name="password"
          onChange={setPassword}
          value={password}
        />
      </ActionDialog>
    );
  }
  return (
    <ActionDialog<RecoveryCodes>
      confirmLabel="Turn on"
      description="Add this account to an authenticator app such as 1Password, Google Authenticator, or Authy, then enter the six-digit code it shows."
      invalid={!/^\d{6}$/u.test(code.replaceAll(/\s/gu, ""))}
      onClose={closeStep}
      onSuccess={(result) => {
        advance();
        setIssued(result);
      }}
      open
      runOnce={() => confirmMfaEnrollmentFn({ data: { code } })}
      size="xl"
      successMessage="Two-factor authentication is on."
      title="Add to your authenticator"
    >
      <EnrollSteps current={2} />
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <OtpauthQrCode uri={enrollment.otpauthUri} />
        <div className="w-full min-w-0 space-y-3">
          <CopyField label="Setup key" value={enrollment.secret} />
          <CopyField label="Setup link" value={enrollment.otpauthUri} />
          <Description>
            Scan the code, or type the setup key into your app by hand. Choose a time-based (TOTP)
            account.
          </Description>
        </div>
      </div>
      <CodeField
        description="The six-digit code from your authenticator app."
        onChange={setCode}
        value={code}
      />
    </ActionDialog>
  );
}

function RegenerateCodesDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [issued, setIssued] = useState<RecoveryCodes>();
  const { advance, closeStep } = useStepClose(onClose);
  if (issued) {
    return <RecoveryCodesDialog codes={issued.recoveryCodes} onDone={onClose} />;
  }
  return (
    <ActionDialog<RecoveryCodes>
      confirmLabel="Replace codes"
      description="Your current recovery codes stop working and ten new ones replace them."
      invalid={!isVerificationCode(code)}
      onClose={closeStep}
      onSuccess={(result) => {
        advance();
        void invalidateAccount(queryClient);
        setIssued(result);
      }}
      open
      runOnce={() => regenerateRecoveryCodesFn({ data: { code } })}
      successMessage="New recovery codes issued."
      title="Replace recovery codes"
    >
      <CodeField
        description="A code from your authenticator app, or an unused recovery code."
        onChange={setCode}
        value={code}
      />
    </ActionDialog>
  );
}

function DisableMfaDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  return (
    <ActionDialog
      confirmLabel="Turn off"
      description="Signing in will need only your password. We email you that it changed."
      destructive
      invalid={!isVerificationCode(code)}
      onClose={onClose}
      onSuccess={() => void invalidateAccount(queryClient)}
      open
      runOnce={() => disableMfaFn({ data: { code } })}
      successMessage="Two-factor authentication is off."
      title="Turn off two-factor authentication"
    >
      <CodeField
        description="A code from your authenticator app, or an unused recovery code."
        onChange={setCode}
        value={code}
      />
    </ActionDialog>
  );
}

export function AccountDialogs({
  dialog,
  onClose,
}: Readonly<{ dialog: AccountDialog | undefined; onClose: () => void }>) {
  const queryClient = useQueryClient();
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "change-password":
      return <ChangePasswordDialog onClose={onClose} />;
    case "enroll-mfa":
      return <EnrollMfaDialog onClose={onClose} />;
    case "regenerate-codes":
      return <RegenerateCodesDialog onClose={onClose} />;
    case "disable-mfa":
      return <DisableMfaDialog onClose={onClose} />;
    case "revoke-session":
      return (
        <ActionDialog<{ readonly current: boolean }>
          confirmLabel="Sign out"
          description="That browser is signed out at once, and console sessions started from it end within ten minutes."
          destructive
          onClose={onClose}
          onSuccess={(result) => {
            if (result.current) leaveForSignIn();
            else void invalidateAccount(queryClient);
          }}
          open
          runOnce={() => revokeAccountSessionFn({ data: { sessionId: dialog.sessionId } })}
          successMessage="Session signed out."
          title="Sign out this session"
        />
      );
    case "sign-out-everywhere":
      return (
        <ActionDialog
          confirmLabel="Sign out everywhere"
          confirmation="sign out everywhere"
          description={
            <>
              Every browser, console, and CLI session ends, including this one. Type{" "}
              <Code>sign out everywhere</Code> to confirm.
            </>
          }
          destructive
          onClose={onClose}
          onSuccess={leaveForSignIn}
          open
          runOnce={() => signOutEverywhereFn()}
          successMessage="Signed out everywhere."
          title="Sign out everywhere"
        />
      );
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}
