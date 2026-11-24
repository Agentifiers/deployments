import { useMutation } from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { EnvironmentSummary } from "../server/console-data.ts";
import { PlatformApiError, UnauthenticatedError, type PlatformProblem } from "../errors.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, Fieldset, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Code } from "@/components/ui/text";
import { attemptAfterFailure, dialogLock, freshAttempt } from "./keyed-attempt.ts";
import { describeProblem, ProblemReference } from "./section-boundary.tsx";

/**
 * The phrase a user must type before a mutation runs: always for destructive actions (stop,
 * revoke, abort, secret rotation), and for `live` actions, which change what production traffic
 * runs (deploying, retargeting, publishing), in a production environment. `undefined` skips it.
 */
export function typedConfirmation(
  environmentType: EnvironmentSummary["type"],
  options: { readonly destructive?: boolean; readonly live?: boolean; readonly phrase: string },
): string | undefined {
  return options.destructive || (options.live && environmentType === "production")
    ? options.phrase
    : undefined;
}

/** Controls Tab reaches inside `container`, in document order. */
function tabbables(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(
        ":disabled, [type=hidden], [aria-hidden=true], [data-base-ui-focus-guard]",
      ) &&
      (element.checkVisibility?.() ?? true),
  );
}

/** The dialog's first form field, where it opens with focus; else the dialog panel itself. */
function firstField(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  return (
    tabbables(container).find((element) => element.matches("input, select, textarea")) ?? container
  );
}

/**
 * Wraps Tab from the last control to the first, and Shift+Tab from the first to the last, in the
 * same keystroke. Base UI's focus guards move focus back a frame later, so a second Tab pressed
 * within that frame left the dialog for the page behind it.
 */
function wrapTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const container = event.currentTarget;
  const active = container.ownerDocument.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return;
  const controls = tabbables(container);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  const target = event.shiftKey
    ? active === first || active === container
      ? last
      : undefined
    : active === last
      ? first
      : undefined;
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
}

/** A 409 means the screen is stale: refresh it, and still show the conflict. */
export async function refreshOnConflict<Result>(
  mutation: Promise<Result>,
  refresh: () => unknown,
): Promise<Result> {
  try {
    return await mutation;
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 409) void refresh();
    throw error;
  }
}

/**
 * `resend` is true when the last submission under `idempotencyKey` may have applied, so a body
 * built from live values must repeat what it sent under that key (see `useKeyedSnapshot`).
 */
export type ActionRun<Result> =
  | {
      readonly run: (idempotencyKey: string, resend: boolean) => Promise<Result>;
      readonly runOnce?: never;
    }
  | { readonly run?: never; readonly runOnce: () => Promise<Result> };

export type ActionDialogProps<Result> = ActionRun<Result> & {
  /** Form fields; the dialog owns the submit button, confirmation, and error display. */
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  /** Phrase to type before submitting; see `typedConfirmation`. */
  readonly confirmation?: string | undefined;
  readonly description?: ReactNode;
  readonly destructive?: boolean;
  /** The fields hold edits: closing without submitting first asks whether to discard them. */
  readonly dirty?: boolean;
  /** Blocks submission while the form is incomplete or invalid. */
  readonly invalid?: boolean;
  readonly onClose: () => void;
  readonly onSuccess?: (result: Result) => void;
  readonly open: boolean;
  /** Extra guidance under a failed request's problem, such as a link to what refused it. */
  readonly problemAction?: (problem: PlatformProblem) => ReactNode;
  /**
   * Replaces the default notice shown after a keyed request failed in a way that may have applied
   * it, such as a 5xx or a timeout. The fields lock either way, so submitting again repeats the
   * request under the same key; only the labeled button closes the dialog and abandons it.
   */
  readonly retryNotice?: ReactNode;
  readonly size?: "lg" | "xl" | "2xl" | "3xl";
  /** A `{ neutral }` result reports an outcome that applied nothing, without the success mark. */
  readonly successMessage: string | ((result: Result) => string | { readonly neutral: string });
  /** Takes focus after a success that removes the dialog's trigger, such as a detached row's. */
  readonly successFocus?: RefObject<HTMLElement | null>;
  readonly title: ReactNode;
};

/**
 * Confirmation dialog for one console mutation. Each open generates one idempotency key. After a
 * submission that may have applied, such as on a network failure or 5xx, `dialogLock` decides
 * what the dialog allows next. A refused body applied nothing, so the next submission (usually
 * with corrected input) gets a fresh key, unless an earlier submission under the current key may
 * have applied (see `KeyedAttempt`).
 */
export function ActionDialog<Result>(props: ActionDialogProps<Result>) {
  const {
    children,
    confirmLabel,
    confirmation,
    description,
    destructive = false,
    dirty = false,
    invalid = false,
    onClose,
    onSuccess,
    open,
    problemAction,
    retryNotice,
    size = "lg",
    successFocus,
    successMessage,
    title,
  } = props;
  const [attempt, setAttempt] = useState(freshAttempt);
  const [typed, setTyped] = useState("");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const succeeded = useRef(false);
  const mutation = useMutation({
    mutationFn: () =>
      props.runOnce ? props.runOnce() : props.run(attempt.key, attempt.state === "resend"),
    onError: (error) => setAttempt((current) => attemptAfterFailure(current, error)),
    onSuccess: (result) => {
      const notice = typeof successMessage === "function" ? successMessage(result) : successMessage;
      if (typeof notice === "string") toast.success(notice);
      else toast(notice.neutral);
      succeeded.current = true;
      onSuccess?.(result);
      onClose();
    },
  });
  const { reset } = mutation;

  useEffect(() => {
    if (!open) return;
    setAttempt(freshAttempt());
    succeeded.current = false;
    setTyped("");
    setConfirmingDiscard(false);
    reset();
  }, [open, reset]);

  if (mutation.error instanceof UnauthenticatedError) throw mutation.error;
  const problem = mutation.error
    ? describeProblem(mutation.error, "The request failed")
    : undefined;
  const lock = dialogLock(props.runOnce ? "runOnce" : "run", attempt, retryNotice);
  const locked = lock.kind === "locked";
  const confirmed = confirmation === undefined || typed === confirmation;
  const ready = confirmed && !invalid && lock.kind !== "refused" && !mutation.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) mutation.mutate();
  };

  const dismissable = !mutation.isPending && !locked;
  const close = () => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && dismissable) close();
      }}
      open={open}
    >
      <DialogContent
        finalFocus={successFocus && (() => (succeeded.current ? successFocus.current : true))}
        initialFocus={() => firstField(popup.current)}
        onKeyDown={wrapTab}
        ref={popup}
        showCloseButton={false}
        size={size}
      >
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <LockableFields locked={locked}>{children}</LockableFields>
          {confirmation === undefined ? null : (
            <Field>
              <Label>
                Type <Code>{confirmation}</Code> to confirm
              </Label>
              <Input
                autoComplete="off"
                name="confirmation"
                onChange={(event) => setTyped(event.target.value)}
                value={typed}
              />
            </Field>
          )}
          {problem ? (
            <Callout variant="destructive">
              <CalloutTitle>{problem.title}</CalloutTitle>
              <CalloutDescription>
                {problem.description ? <p>{problem.description}</p> : null}
                {problemAction && mutation.error instanceof PlatformApiError
                  ? problemAction(mutation.error.problem)
                  : null}
                {lock.kind === "refused" ? (
                  <p>
                    The platform may have applied this. Close the dialog and check before trying
                    again.
                  </p>
                ) : null}
                {lock.kind === "locked" ? <p>{lock.notice}</p> : null}
                <ProblemReference requestId={problem.requestId} status={problem.status} />
              </CalloutDescription>
            </Callout>
          ) : null}
          <DialogFooter>
            <Button
              disabled={mutation.isPending}
              onClick={locked ? onClose : close}
              variant="ghost"
            >
              {/* "Cancel" beside "Cancel run" reads as two ways to do the same thing. */}
              {locked
                ? "Leave unfinished"
                : confirmLabel.startsWith("Cancel")
                  ? "Go back"
                  : "Cancel"}
            </Button>
            <Button
              disabled={!ready}
              type="submit"
              variant={destructive ? "destructive" : "default"}
            >
              {mutation.isPending ? "Working…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
        <Dialog
          onOpenChange={(next) => {
            if (!next) setConfirmingDiscard(false);
          }}
          open={confirmingDiscard}
        >
          <DialogContent onKeyDown={wrapTab} showCloseButton={false} size="sm">
            <DialogHeader>
              <DialogTitle>Discard changes?</DialogTitle>
              <DialogDescription>
                Closing the dialog throws away what you entered.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setConfirmingDiscard(false)} variant="ghost">
                Keep editing
              </Button>
              <Button
                onClick={() => {
                  setConfirmingDiscard(false);
                  onClose();
                }}
                variant="destructive"
              >
                Discard changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

export function LockableFields({
  children,
  locked,
}: Readonly<{ children?: ReactNode; locked: boolean }>) {
  return (
    <Fieldset className="contents" disabled={locked}>
      {children}
    </Fieldset>
  );
}
