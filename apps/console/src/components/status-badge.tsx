import { Badge, type BadgeProps } from "@/components/ui/badge";
import { statusColor, statusLabel } from "@/status";

/** An API status as a colored badge with a readable label. */
export function StatusBadge({
  status,
  ...props
}: Readonly<{ status: string } & Omit<BadgeProps, "children" | "color">>) {
  return (
    <Badge color={statusColor(status)} {...props}>
      {statusLabel(status)}
    </Badge>
  );
}
