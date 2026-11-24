import { cn } from "cn";

type HeadingProps = { level?: 1 | 2 | 3 | 4 | 5 | 6 } & React.ComponentProps<
  "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
>;

function Heading({ className, level = 1, ...props }: HeadingProps) {
  const Element = `h${level}` as const;
  return (
    <Element
      data-slot="heading"
      className={cn(
        "font-heading text-xl leading-8 font-semibold tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function Subheading({ className, level = 2, ...props }: HeadingProps) {
  const Element = `h${level}` as const;
  return (
    <Element
      data-slot="subheading"
      className={cn("font-heading text-sm leading-6 font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export { Heading, Subheading };
