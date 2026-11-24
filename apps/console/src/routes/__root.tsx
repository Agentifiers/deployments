import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import type { ConsoleRouterContext } from "../edition.ts";
import appCss from "../styles/tailwind.css?url";

/** A "D" on the primary color (zinc-900); inline, so no static file has to be served for it. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#18181b"/><path fill="#fff" fill-rule="evenodd" d="M10 8h6a8 8 0 0 1 0 16h-6zm3.5 3.5v9H16a4.5 4.5 0 0 0 0-9z"/></svg>',
)}`;

export const Route = createRootRouteWithContext<ConsoleRouterContext>()({
  head: ({ match }) => ({
    links: [
      { href: appCss, rel: "stylesheet" },
      { href: FAVICON, rel: "icon", type: "image/svg+xml" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: match.context.edition.productName },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html className="bg-background text-foreground antialiased lg:bg-muted" lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
