import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { integrationEndpointsQuery } from "../data/integration-queries.ts";
import { docsUrl } from "../integrations/endpoints.ts";
import { TextLink } from "@/components/ui/text";

/** A page of the install's docs site, or nothing on an install that serves none. */
export function DocsLink({
  children = "Read the docs",
  path,
}: Readonly<{ children?: ReactNode; path: `/docs/${string}` }>) {
  const { data } = useQuery({ ...integrationEndpointsQuery(), retry: false });
  const href = data ? docsUrl(data, path) : undefined;
  if (!href) return null;
  return (
    <TextLink href={href} rel="noreferrer" target="_blank">
      {children}
    </TextLink>
  );
}
