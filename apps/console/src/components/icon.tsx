import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function Icon({ icon, className }: Readonly<{ icon: IconSvgElement; className?: string }>) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      icon={icon}
      strokeWidth={1.8}
      {...(className ? { className } : {})}
    />
  );
}
