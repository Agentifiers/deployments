import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { resourcePath, type ResourceRef } from "../resource-links.ts";
import type { EnvironmentScope } from "../scope.ts";
import { TextLink } from "@/components/ui/text";

export function ResourceLink({
  children,
  scope,
  to,
}: Readonly<{ children: ReactNode; scope: EnvironmentScope; to: ResourceRef }>) {
  const { routesByPath } = useRouter();
  const { href, fullPath } = resourcePath(scope, to);
  return Object.hasOwn(routesByPath, fullPath) ? (
    <TextLink href={href}>{children}</TextLink>
  ) : (
    children
  );
}
