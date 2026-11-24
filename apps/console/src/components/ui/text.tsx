import { cn } from "cn";

import { Link, type LinkProps } from "@/components/ui/link";

function Text({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="text"
      className={cn("text-sm leading-6 text-muted-foreground", className)}
      {...props}
    />
  );
}

function TextLink({ className, ...props }: LinkProps) {
  return (
    <Link
      data-slot="text-link"
      className={cn(
        "font-medium text-foreground underline underline-offset-4 transition-colors hover:text-foreground/70",
        className,
      )}
      {...props}
    />
  );
}

function Strong({ className, ...props }: React.ComponentProps<"strong">) {
  return (
    <strong
      data-slot="strong"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function Code({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      data-slot="code"
      className={cn(
        "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.8125rem] font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Code, Strong, Text, TextLink };
