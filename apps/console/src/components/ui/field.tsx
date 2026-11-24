"use client";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { createContext, useContext } from "react";

// Base UI's Label, Description, Error, and Legend throw outside their Field or Fieldset root.
// Outside a root these render plain elements with the same look, so they stay valid anywhere.
const InsideField = createContext(false);
const InsideFieldset = createContext(false);

const outsideRootDimming = "group-data-disabled/fieldset:opacity-50";

function Fieldset({ className, ...props }: FieldsetPrimitive.Root.Props) {
  return (
    <InsideFieldset.Provider value>
      <FieldsetPrimitive.Root
        data-slot="field-set"
        className={cn(
          "group/fieldset flex flex-col gap-6 [&>[data-slot=field-legend]+[data-slot=field-description]]:-mt-5 [&>[data-slot=field-legend]+[data-slot=text]]:-mt-5",
          className,
        )}
        {...props}
      />
    </InsideFieldset.Provider>
  );
}

const legendClasses = "text-sm/6 font-semibold data-disabled:opacity-50";

function Legend({ className, ...props }: React.ComponentProps<"div">) {
  if (!useContext(InsideFieldset)) {
    return <div data-slot="field-legend" className={cn(legendClasses, className)} {...props} />;
  }
  return (
    <FieldsetPrimitive.Legend
      data-slot="field-legend"
      className={cn(legendClasses, className)}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-8 *:data-[slot=field-group]:gap-4 not-has-[>[data-orientation=vertical]]:has-[>[data-orientation=horizontal]]:gap-3 not-has-[>[data-orientation=vertical]]:has-[>[data-orientation=horizontal]>[data-slot=field-description]]:gap-6",
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva("group/field flex w-full data-invalid:text-destructive", {
  variants: {
    orientation: {
      vertical:
        "flex-col gap-3 *:w-full [&>.sr-only]:w-auto [&>[data-slot=field-label]+[data-slot=field-description]]:-mt-2",
      horizontal:
        "flex-row flex-wrap items-center gap-x-2 gap-y-1 *:data-[slot=field-label]:flex-auto *:data-[slot=field-description]:basis-full *:data-[slot=field-description]:pl-6",
    },
  },
  defaultVariants: {
    orientation: "vertical",
  },
});

type FieldProps = FieldPrimitive.Root.Props & VariantProps<typeof fieldVariants>;

function Field({ className, orientation = "vertical", ...props }: FieldProps) {
  return (
    <InsideField.Provider value>
      <FieldPrimitive.Root
        data-slot="field"
        data-orientation={orientation}
        className={cn(fieldVariants({ orientation }), className)}
        {...props}
      />
    </InsideField.Provider>
  );
}

function CheckboxField(props: Omit<FieldProps, "orientation">) {
  return <Field orientation="horizontal" {...props} />;
}

function RadioField(props: Omit<FieldProps, "orientation">) {
  return <Field orientation="horizontal" {...props} />;
}

function SwitchField({ className, ...props }: Omit<FieldProps, "orientation">) {
  return (
    <Field
      orientation="horizontal"
      className={cn(
        "grid w-auto grid-cols-[1fr_auto] gap-x-8 *:data-[slot=field-description]:col-start-1 *:data-[slot=field-description]:row-start-2 *:data-[slot=field-description]:pl-0 *:data-[slot=field-label]:col-start-1 *:data-[slot=field-label]:row-start-1 *:data-[slot=switch]:col-start-2 *:data-[slot=switch]:row-start-1",
        className,
      )}
      {...props}
    />
  );
}

const labelClasses =
  "flex w-fit items-center gap-2 text-sm leading-snug font-medium select-none data-disabled:cursor-not-allowed data-disabled:opacity-50";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  if (!useContext(InsideField)) {
    return (
      <label
        data-slot="field-label"
        className={cn(labelClasses, outsideRootDimming, className)}
        {...props}
      />
    );
  }
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn(labelClasses, className)}
      {...props}
    />
  );
}

const descriptionClasses =
  "text-left text-sm leading-normal font-normal text-muted-foreground data-disabled:opacity-50 [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary";

function Description({ className, ...props }: React.ComponentProps<"p">) {
  if (!useContext(InsideField)) {
    return (
      <p
        data-slot="field-description"
        className={cn(descriptionClasses, outsideRootDimming, className)}
        {...props}
      />
    );
  }
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn(descriptionClasses, className)}
      {...props}
    />
  );
}

const errorClasses = "text-sm font-normal text-destructive data-disabled:opacity-50";

function ErrorMessage({ className, ...props }: React.ComponentProps<"div">) {
  if (!useContext(InsideField)) {
    return (
      <div
        data-slot="field-error"
        className={cn(errorClasses, outsideRootDimming, className)}
        {...props}
      />
    );
  }
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      match
      className={cn(errorClasses, className)}
      {...props}
    />
  );
}

export {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  FieldGroup,
  Fieldset,
  Label,
  Legend,
  RadioField,
  SwitchField,
};
