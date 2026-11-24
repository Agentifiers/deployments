import { cn } from "cn";

import { Badge as ReuiBadge, type BadgeProps as ReuiBadgeProps } from "@/components/reui/badge";

type BadgeTone = { variant: ReuiBadgeProps["variant"]; className?: string };

const colorTones = {
  amber: { variant: "warning-light" },
  blue: { variant: "info-light" },
  green: { variant: "success-light" },
  indigo: { variant: "focus-light" },
  red: { variant: "destructive-light" },
  sky: { variant: "secondary", className: "border-sky-500/15 bg-sky-500/10 text-sky-900" },
  zinc: { variant: "secondary", className: "bg-zinc-600/10 text-zinc-700" },
} as const satisfies Record<string, BadgeTone>;

type BadgeColor = keyof typeof colorTones;

type BadgeProps = Omit<ReuiBadgeProps, "variant"> & { color?: BadgeColor | undefined };

function Badge({ color = "zinc", className, ...props }: BadgeProps) {
  const tone: BadgeTone = colorTones[color];
  return (
    <ReuiBadge
      variant={tone.variant}
      className={cn(
        "static h-auto min-h-6 min-w-6 shrink px-1.5 py-0.5 whitespace-normal",
        tone.className,
        className,
      )}
      {...props}
    />
  );
}

export { Badge, type BadgeColor, type BadgeProps };
