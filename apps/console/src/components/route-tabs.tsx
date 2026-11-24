import { Link } from "@tanstack/react-router";
import { cn } from "cn";

export interface RouteTab {
  readonly current: boolean;
  readonly href: string;
  readonly label: string;
}

/**
 * Tabs that are routes: each tab is a link, so tabs deep-link and keep browser history. `current`
 * decides the active tab (a tab may stay current on its child pages); the router's own active
 * state is limited to exact matches so it never marks a parent tab current on a child tab.
 *
 * Styled like the `line` variant of `@/components/ui/tabs`, but kept as navigation links rather
 * than a Base UI tablist: these switch pages, so they have no tab panels to own.
 */
export function RouteTabs({ label, tabs }: Readonly<{ label: string; tabs: readonly RouteTab[] }>) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-border"
      data-slot="route-tabs"
    >
      {tabs.map((tab) => (
        <Link
          activeOptions={{ exact: true, includeSearch: false }}
          aria-current={tab.current ? "page" : undefined}
          className={cn(
            "relative px-2 py-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none",
            "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground after:opacity-0 after:transition-opacity",
            "focus-visible:rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50",
            tab.current
              ? "text-foreground after:opacity-100"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={tab.href}
          to={tab.href}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
