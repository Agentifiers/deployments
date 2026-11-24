import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@/components/ui/link";
import { Icon } from "./icon.tsx";

/** The link above a detail page that returns to the list it belongs to. */
export function BackLink({ href, label }: Readonly<{ href: string; label: string }>) {
  return (
    <Link
      className="flex w-fit items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
      href={href}
    >
      <Icon className="size-4" icon={ArrowLeft01Icon} />
      {label}
    </Link>
  );
}
