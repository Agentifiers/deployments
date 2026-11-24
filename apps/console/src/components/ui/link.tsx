import { Link as RouterLink } from "@tanstack/react-router";
import type * as React from "react";

type LinkProps = Omit<React.ComponentProps<"a">, "href"> & {
  href: string;
  reloadDocument?: boolean | undefined;
};

function Link({ href, target, reloadDocument, ...props }: LinkProps) {
  return (
    <RouterLink
      {...props}
      to={href}
      {...(target === undefined ? {} : { target })}
      {...(reloadDocument === undefined ? {} : { reloadDocument })}
    />
  );
}

export { Link, type LinkProps };
