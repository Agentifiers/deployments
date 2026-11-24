import { SYSTEM_PAGES } from "./components/system/system-shell.tsx";
import type { ConsoleEdition } from "./edition.ts";
import { ENVIRONMENT_NAVIGATION, isCurrent, ORGANIZATION_NAVIGATION } from "./navigation.ts";
import type { OrganizationShell } from "./server/console-data.ts";

/** The browser tab title: the page, then where it is, then the product, most specific first. */
export function pageTitle(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" · ");
}

/**
 * The tab title for an organization or environment page, named like its sidebar item, as in
 * "Agents · production · Deployments.ai". A page the sidebar does not list is titled by its
 * environment or organization alone.
 */
export function organizationPageTitle({
  edition,
  pathname,
  shell,
}: Readonly<{ edition: ConsoleEdition; pathname: string; shell: OrganizationShell }>): string {
  const path = pathname.replace(/\/+$/u, "");
  const { organization } = shell;
  const environment = shell.projects
    .flatMap((entry) => entry.environments)
    .find((candidate) => {
      const base = `/o/${organization.id}/p/${candidate.projectId}/e/${candidate.id}`;
      return path === base || path.startsWith(`${base}/`);
    });
  if (environment) {
    const item = ENVIRONMENT_NAVIGATION.flatMap((section) => section.items).find((candidate) =>
      isCurrent(candidate, path),
    );
    return pageTitle(item?.label, environment.name, edition.productName);
  }
  const consolePage = ORGANIZATION_NAVIGATION.items.find((item) => isCurrent(item, path));
  const hostPage = edition.organizationNavigation.find((item) => {
    const href = item.href(organization.id);
    return path === href || path.startsWith(`${href}/`);
  });
  return pageTitle(consolePage?.label ?? hostPage?.label, organization.name, edition.productName);
}

/** The tab title for an install-operator page, as in "Health · System · Deployments.ai Console". */
export function systemPageTitle({
  edition,
  pathname,
}: Readonly<{ edition: ConsoleEdition; pathname: string }>): string {
  const path = pathname.replace(/\/+$/u, "") || "/";
  const page = SYSTEM_PAGES.filter((candidate) =>
    candidate.match === "exact"
      ? path === candidate.to
      : path === candidate.to || path.startsWith(`${candidate.to}/`),
  ).at(-1);
  return pageTitle(page?.label, "System", edition.productName);
}
