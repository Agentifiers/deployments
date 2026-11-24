import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const SITE_NAME = "Deployments.ai Docs";
export const PRODUCT_NAME = "Deployments.ai";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold">
          {PRODUCT_NAME} <span className="text-fd-muted-foreground font-normal">Docs</span>
        </span>
      ),
      url: "/",
    },
    links: [{ text: "Documentation", url: "/docs/", active: "nested-url" }],
  };
}
