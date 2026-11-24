import { cn } from "cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "relative isolate overflow-hidden rounded-lg bg-foreground/[0.07]",
        "motion-safe:before:absolute motion-safe:before:inset-0 motion-safe:before:-translate-x-full motion-safe:before:animate-skeleton-shimmer motion-safe:before:bg-linear-to-r motion-safe:before:from-transparent motion-safe:before:via-white/70 motion-safe:before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
