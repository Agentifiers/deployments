"use client";

import * as React from "react";
import { cn } from "cn";

import { Link } from "@/components/ui/link";

type TableProps = React.ComponentProps<"table"> & {
  dense?: boolean | undefined;
  striped?: boolean | undefined;
};

function Table({ className, dense, striped, ...props }: TableProps) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        data-dense={dense || undefined}
        data-striped={striped || undefined}
        className={cn("group/table w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

type RowLink = { href: string; target: string | undefined; title: string | undefined };

const TableRowLinkContext = React.createContext<RowLink | undefined>(undefined);

type TableRowProps = React.ComponentProps<"tr"> & {
  href?: string | undefined;
  target?: string | undefined;
};

function TableRow({ className, href, target, title, ...props }: TableRowProps) {
  return (
    <TableRowLinkContext.Provider value={href === undefined ? undefined : { href, target, title }}>
      <tr
        data-slot="table-row"
        title={href === undefined ? title : undefined}
        className={cn(
          "border-b transition-colors has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted [[data-striped]_tbody_&]:border-0 [[data-striped]_tbody_&]:even:bg-muted/50",
          href !== undefined &&
            "hover:bg-muted [[data-striped]_tbody_&]:even:hover:bg-muted has-[[data-row-link]:focus-visible]:outline-2 has-[[data-row-link]:focus-visible]:-outline-offset-2 has-[[data-row-link]:focus-visible]:outline-ring",
          className,
        )}
        {...props}
      />
    </TableRowLinkContext.Provider>
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, children, ...props }: React.ComponentProps<"td">) {
  const link = React.useContext(TableRowLinkContext);
  const [cell, setCell] = React.useState<HTMLTableCellElement | null>(null);
  return (
    <td
      ref={link ? setCell : undefined}
      data-slot="table-cell"
      className={cn(
        "relative px-2 py-3 align-middle whitespace-nowrap group-data-dense/table:py-2 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    >
      {link && (
        <Link
          data-row-link=""
          href={link.href}
          target={link.target}
          aria-label={link.title}
          tabIndex={cell?.previousElementSibling ? -1 : 0}
          className="absolute inset-0 focus:outline-hidden"
        />
      )}
      {children}
    </td>
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
