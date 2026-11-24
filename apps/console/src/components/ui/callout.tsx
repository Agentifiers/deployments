import { cn } from "cn";

import { Alert } from "@/components/reui/alert";

const iconTones = {
  success: "[&>svg]:text-success-foreground",
  warning: "[&>svg]:text-warning-foreground",
} as const;

function Callout({ className, variant, ...props }: React.ComponentProps<typeof Alert>) {
  return (
    <Alert
      role={variant === "destructive" ? "alert" : "status"}
      variant={variant}
      data-variant={variant ?? "default"}
      className={cn(
        "group/callout",
        (variant === "success" || variant === "warning") && iconTones[variant],
        className,
      )}
      {...props}
    />
  );
}

function CalloutTitle({ className, ...props }: React.ComponentProps<"h4">) {
  return (
    <h4
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-4 font-semibold tracking-tight group-data-[variant=destructive]/callout:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function CalloutDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 block text-sm text-muted-foreground group-data-[variant=destructive]/callout:text-destructive [&_a]:underline [&_p+p]:mt-2 [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

function CalloutAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "flex gap-1.5 max-sm:col-start-2 max-sm:mt-2 max-sm:justify-start sm:col-start-3 sm:row-start-1 sm:justify-end sm:self-center sm:pl-3",
        className,
      )}
      {...props}
    />
  );
}

export { Callout, CalloutAction, CalloutDescription, CalloutTitle };
