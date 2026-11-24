"use client";

import { cn } from "cn";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({ toastOptions, ...props }: ToasterProps) {
  const classes = toastOptions?.classNames;
  return (
    <Sonner
      closeButton
      {...props}
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        classNames: {
          ...classes,
          toast: cn(
            "flex w-full items-center gap-3 rounded-xl border border-border bg-popover p-4 text-sm/6 text-popover-foreground shadow-lg",
            classes?.toast,
          ),
          title: cn("font-semibold", classes?.title),
          description: cn("text-muted-foreground", classes?.description),
          content: cn("flex min-w-0 flex-1 flex-col gap-1", classes?.content),
          actionButton: cn(
            "shrink-0 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            classes?.actionButton,
          ),
          cancelButton: cn(
            "shrink-0 rounded-lg border border-border bg-muted px-3 py-1.5 text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            classes?.cancelButton,
          ),
          closeButton: cn(
            "border-border! bg-popover! text-foreground! focus-visible:outline-2 focus-visible:outline-ring",
            classes?.closeButton,
          ),
          error: cn("border-destructive/40", classes?.error),
        },
      }}
    />
  );
}

export { Toaster };
export { toast } from "sonner";
