import { cn } from "cn";

// Rows are dt/dd pairs laid out by the grid, so the first pair is found with
// :first-of-type and every later pair draws its own top rule.
function DescriptionList({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      data-slot="description-list"
      className={cn(
        "grid grid-cols-1 gap-x-8 text-sm leading-6 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]",
        className,
      )}
      {...props}
    />
  );
}

function DescriptionTerm({ className, ...props }: React.ComponentProps<"dt">) {
  return (
    <dt
      data-slot="description-term"
      className={cn(
        "col-start-1 border-t border-border pt-2.5 text-muted-foreground first-of-type:border-t-0 sm:py-2.5",
        className,
      )}
      {...props}
    />
  );
}

function DescriptionDetails({ className, ...props }: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="description-details"
      className={cn(
        "pb-2.5 text-foreground sm:border-t sm:border-border sm:py-2.5 sm:first-of-type:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

export { DescriptionDetails, DescriptionList, DescriptionTerm };
