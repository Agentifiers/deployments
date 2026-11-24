import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useRef, useState, type ReactNode } from "react";
import type { ShownOnce } from "../shown-once.ts";
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
import { CheckboxField, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { ActionDialog, type ActionDialogProps, type ActionRun } from "./action-dialog.tsx";
import { Icon } from "./icon.tsx";

export type SecretActionDialogProps<View> = ActionRun<ShownOnce<View>> &
  Omit<ActionDialogProps<View>, "onSuccess" | "run" | "runOnce" | "successMessage"> & {
    readonly onIssued: (view: View) => void;
    readonly onStored: (view: View) => void;
    readonly secretDescription: (view: View) => ReactNode;
    readonly secretLabel: string;
    readonly successMessage: string;
  };

export function SecretActionDialog<View>(props: SecretActionDialogProps<View>) {
  const {
    onClose,
    onIssued,
    onStored,
    open,
    run: _run,
    runOnce: _runOnce,
    secretDescription,
    secretLabel,
    ...dialog
  } = props;
  const [revealed, setRevealed] = useState<ShownOnce<View>>();
  const [stored, setStored] = useState(false);
  const holdOpenForReveal = useRef(false);
  const { copyToClipboard } = useCopyToClipboard({
    timeout: 0,
    onCopy: () => toast.success(`Copied the ${secretLabel}.`),
    onError: () => toast.error("Copying failed. Select the value and copy it."),
  });

  const returnViewKeepSecretInState =
    <Args extends unknown[]>(call: (...args: Args) => Promise<ShownOnce<View>>) =>
    async (...args: Args) => {
      const shown = await call(...args);
      holdOpenForReveal.current = true;
      setRevealed(shown);
      return shown.view;
    };
  const action: ActionRun<View> = props.runOnce
    ? { runOnce: returnViewKeepSecretInState(props.runOnce) }
    : { run: returnViewKeepSecretInState(props.run) };
  const finish = (view: View) => {
    holdOpenForReveal.current = false;
    setRevealed(undefined);
    setStored(false);
    onStored(view);
    onClose();
  };

  return (
    <>
      <ActionDialog<View>
        {...dialog}
        {...action}
        onClose={() => {
          if (!holdOpenForReveal.current) onClose();
        }}
        onSuccess={onIssued}
        open={open && revealed === undefined}
      />
      {revealed ? (
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Store the {secretLabel}</DialogTitle>
              <DialogDescription>
                {secretDescription(revealed.view)} The console shows it only now; store it before
                you continue.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <Label>{secretLabel}</Label>
              <div className="flex gap-2">
                <Input
                  className="font-mono"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={revealed.secret}
                />
                <Button onClick={() => copyToClipboard(revealed.secret)} variant="outline">
                  <Icon icon={Copy01Icon} />
                  Copy
                </Button>
              </div>
            </Field>
            <CheckboxField>
              <Checkbox checked={stored} onCheckedChange={(checked) => setStored(checked)} />
              <Label>I stored this {secretLabel}</Label>
            </CheckboxField>
            <DialogFooter>
              <Button disabled={!stored} onClick={() => finish(revealed.view)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
