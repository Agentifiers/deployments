import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "./icon.tsx";

/**
 * A public ID in monospace, plus copy. Truncated to its tail with the full value in the tooltip,
 * unless `full`, for the few places where reading the whole ID is the point.
 */
export function PublicId({ full = false, value }: Readonly<{ full?: boolean; value: string }>) {
  const { isCopied, copyToClipboard } = useCopyToClipboard({ timeout: 1_500 });
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs/5 text-muted-foreground">
      {full ? <span>{value}</span> : <span title={value}>…{value.slice(-8)}</span>}
      <button
        aria-label={isCopied ? "Copied" : `Copy ${value}`}
        className="relative z-10 rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          copyToClipboard(value);
        }}
        type="button"
      >
        <Icon className="size-3.5" icon={isCopied ? Tick02Icon : Copy01Icon} />
      </button>
    </span>
  );
}
