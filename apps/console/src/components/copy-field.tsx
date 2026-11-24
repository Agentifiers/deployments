import { Copy01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "./icon.tsx";

export function CopyField({ label, value }: Readonly<{ label: string; value: string }>) {
  const { copyToClipboard } = useCopyToClipboard({
    timeout: 0,
    onCopy: () => toast.success(`Copied the ${label.toLowerCase()}.`),
    onError: () => toast.error("Copying failed. Select the value and copy it."),
  });
  return (
    <Field>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input aria-label={label} className="font-mono" readOnly value={value} />
        <Button
          aria-label={`Copy the ${label.toLowerCase()}`}
          onClick={() => copyToClipboard(value)}
          variant="outline"
        >
          <Icon icon={Copy01Icon} />
          Copy
        </Button>
      </div>
    </Field>
  );
}
