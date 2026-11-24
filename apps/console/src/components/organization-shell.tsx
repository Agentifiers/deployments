import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  LogoutSquare01Icon,
  PlusSignIcon,
  SecurityCheckIcon,
  ServerStack01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "cn";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/components/ui/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { showsSystem, useConsoleEdition } from "../edition.ts";
import {
  ENVIRONMENT_NAVIGATION,
  environmentHref,
  isCurrent,
  type NavSection,
  organizationLinks,
  visibleSections,
} from "../navigation.ts";
import type { EnvironmentSummary, OrganizationShell } from "../server/console-data.ts";
import { ENVIRONMENT_TYPE_COLORS, statusColor, statusLabel } from "../status.ts";
import { Icon } from "./icon.tsx";
import { SIGN_OUT_FORM_ID, SignOutForm } from "./sign-out.tsx";
import { OrganizationNotices } from "./tenancy/organization-notices.tsx";
import { CreateOrganizationDialog } from "./tenancy/create-dialogs.tsx";

function environmentPath(organizationId: string, environment: EnvironmentSummary) {
  return `/o/${organizationId}/p/${environment.projectId}/e/${environment.id}`;
}

export function EnvironmentTypeBadge({ type }: Readonly<{ type: EnvironmentSummary["type"] }>) {
  return <Badge color={ENVIRONMENT_TYPE_COLORS[type]}>{type}</Badge>;
}

/**
 * The signed-in member's initials: the first letters of the first and last words of their display
 * name, else of their email's local part split at dots and dashes, else "Me".
 */
export function memberInitials(profile: OrganizationShell["profile"]): string {
  const source = profile?.displayName?.trim() || profile?.primaryEmail?.split("@")[0];
  const words = (source ?? "").split(/[\s._+-]+/u).filter((word) => word !== "");
  const [first] = words;
  if (first === undefined) return "Me";
  const last = words.length > 1 ? words.at(-1) : undefined;
  return `${firstCharacter(first)}${last ? firstCharacter(last) : ""}`.toUpperCase();
}

/** A fixed locale, so the server and the browser pick the same character. */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

function firstCharacter(word: string): string {
  return GRAPHEMES.segment(word)[Symbol.iterator]().next().value?.segment ?? "";
}

function SquareAvatar({ className, initials }: Readonly<{ className?: string; initials: string }>) {
  return (
    <Avatar aria-hidden className={cn("rounded-lg after:rounded-lg", className)}>
      <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
    </Avatar>
  );
}

export function ConsoleShell({
  actions,
  children,
  sidebar,
}: Readonly<{ actions?: ReactNode; children: ReactNode; sidebar: ReactNode }>) {
  return (
    <SidebarProvider>
      <Sidebar variant="inset">{sidebar}</Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger />
          <div className="ml-auto flex items-center gap-3">{actions}</div>
        </header>
        <div className="mx-auto w-full max-w-6xl grow px-6 pb-10 lg:px-10">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function SidebarLink({
  children,
  current = false,
  href,
}: Readonly<{ children: ReactNode; current?: boolean; href: string }>) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current}
        onClick={() => setOpenMobile(false)}
        render={<Link href={href} />}
      >
        {children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavigationSections<To extends string>({
  href,
  pathname,
  sections,
}: Readonly<{
  href: (to: To) => string;
  pathname: string;
  sections: readonly NavSection<To, string>[];
}>) {
  return sections.map((section) => (
    <SidebarGroup key={section.heading}>
      <SidebarGroupLabel render={<h3 />}>{section.heading}</SidebarGroupLabel>
      <SidebarMenu>
        {section.items.map((item) => (
          <SidebarLink current={isCurrent(item, pathname)} href={href(item.to)} key={item.to}>
            <Icon icon={item.icon} />
            <span>{item.label}</span>
          </SidebarLink>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  ));
}

const FADE = "1.5rem";

/**
 * Keeps the current page's nav item in view and fades whichever edge has more items past it, so
 * a sidebar taller than the window shows that it scrolls.
 */
function useNavigationScroll(pathname: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ bottom: false, top: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
    const update = () =>
      setEdges({
        bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
        top: element.scrollTop > 0,
      });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const resized = new ResizeObserver(update);
    resized.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      resized.disconnect();
    };
  }, [pathname]);
  const mask = `linear-gradient(to bottom, ${edges.top ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${edges.bottom ? "transparent" : "black"})`;
  const style: CSSProperties | undefined =
    edges.top || edges.bottom ? { maskImage: mask, WebkitMaskImage: mask } : undefined;
  return { ref, style };
}

function UserMenuItems({ shell }: Readonly<{ shell: OrganizationShell }>) {
  const label = shell.profile?.primaryEmail ?? shell.profile?.displayName;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <DropdownMenuItem className={label ? undefined : "font-mono"} disabled>
          {label ?? shell.principalId}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem render={<Link href="/account" />}>
          <Icon icon={SecurityCheckIcon} />
          Account security
        </DropdownMenuItem>
        <DropdownMenuItem nativeButton render={<button form={SIGN_OUT_FORM_ID} type="submit" />}>
          <Icon icon={LogoutSquare01Icon} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}

/**
 * Application shell for the organization and environment levels: organization switcher,
 * project → environment switcher, and a sidebar listing only screens that exist and that the
 * caller may use.
 */
export function OrganizationShellLayout({
  children,
  environmentId,
  shell,
}: Readonly<{ children: ReactNode; environmentId: string | undefined; shell: OrganizationShell }>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const edition = useConsoleEdition();
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const { access, organization } = shell;
  const environment = shell.projects
    .flatMap((entry) => entry.environments)
    .find((candidate) => candidate.id === environmentId);
  const project = shell.projects.find((entry) => entry.project.id === environment?.projectId);
  const organizationPages = organizationLinks(edition, access, organization.id, pathname);
  const navigationScroll = useNavigationScroll(pathname);
  const userName = shell.profile?.displayName ?? shell.profile?.primaryEmail;
  const initials = memberInitials(shell.profile);
  const roleLabel =
    shell.authorization.organizationRole ??
    (shell.authorization.platformRole ? "Platform administrator" : "Member");

  return (
    <>
      <SignOutForm />
      <ConsoleShell
        actions={
          <div className="flex items-center gap-3 md:hidden">
            {environment ? <EnvironmentTypeBadge type={environment.type} /> : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account"
                className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <SquareAvatar initials={initials} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-64">
                <UserMenuItems shell={shell} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
        sidebar={
          <>
            <SidebarHeader>
              <SidebarMenu>
                <SidebarMenuItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<SidebarMenuButton aria-label="Switch organization" size="lg" />}
                    >
                      <SquareAvatar initials={organization.name.slice(0, 2)} />
                      <span className="flex-1 truncate font-medium">{organization.name}</span>
                      <Icon icon={ArrowDown01Icon} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-64">
                      {organizationPages.length > 0 ? (
                        <>
                          <DropdownMenuGroup>
                            {organizationPages.map((page) => (
                              <DropdownMenuItem key={page.href} render={<Link href={page.href} />}>
                                <Icon icon={page.switcher?.icon ?? page.icon} />
                                {page.switcher?.label ?? page.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      <DropdownMenuGroup>
                        {shell.organizations.map((candidate) => (
                          <DropdownMenuItem
                            key={candidate.id}
                            render={<Link href={`/o/${candidate.id}`} />}
                          >
                            <SquareAvatar
                              className="size-6"
                              initials={candidate.name.slice(0, 2)}
                            />
                            <span className="flex-1 truncate">{candidate.name}</span>
                            {candidate.id === organization.id ? <Icon icon={Tick02Icon} /> : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => setCreatingOrganization(true)}>
                          <Icon icon={PlusSignIcon} />
                          Create organization
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<SidebarMenuButton aria-label="Switch environment" />}
                    >
                      <span className="flex-1 truncate font-medium">
                        {environment && project
                          ? `${project.project.name} / ${environment.name}`
                          : "Choose an environment"}
                      </span>
                      {environment ? <EnvironmentTypeBadge type={environment.type} /> : null}
                      <Icon icon={ArrowDown01Icon} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-64">
                      {shell.projects.length === 0 ? (
                        <DropdownMenuGroup>
                          <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
                        </DropdownMenuGroup>
                      ) : null}
                      {shell.projects.map(({ environments, project: candidate }) => (
                        <DropdownMenuGroup key={candidate.id}>
                          <DropdownMenuLabel>{candidate.name}</DropdownMenuLabel>
                          {environments.length === 0 ? (
                            <DropdownMenuItem disabled>No environments</DropdownMenuItem>
                          ) : null}
                          {environments.map((entry) => (
                            <DropdownMenuItem
                              key={entry.id}
                              render={<Link href={environmentPath(organization.id, entry)} />}
                            >
                              <span className="flex-1 truncate">{entry.name}</span>
                              <EnvironmentTypeBadge type={entry.type} />
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarHeader>

            <SidebarContent
              className="[&_[data-active]]:scroll-my-8"
              ref={navigationScroll.ref}
              style={navigationScroll.style}
            >
              {environment ? (
                <NavigationSections
                  href={(to) =>
                    environmentHref(to, {
                      environmentId: environment.id,
                      organizationId: organization.id,
                      projectId: environment.projectId,
                    })
                  }
                  pathname={pathname}
                  sections={visibleSections(ENVIRONMENT_NAVIGATION, access, edition.hiddenRoutes)}
                />
              ) : organizationPages.length > 0 ? (
                <SidebarGroup>
                  <SidebarGroupLabel render={<h3 />}>Organization</SidebarGroupLabel>
                  <SidebarMenu>
                    {organizationPages.map((page) => (
                      <SidebarLink current={page.current} href={page.href} key={page.href}>
                        <Icon icon={page.icon} />
                        <span>{page.label}</span>
                      </SidebarLink>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              ) : null}

              {access.getSystemInstallation && showsSystem(edition) ? (
                <SidebarGroup className="mt-auto">
                  <SidebarMenu>
                    <SidebarLink href="/system">
                      <Icon icon={ServerStack01Icon} />
                      <span>System</span>
                    </SidebarLink>
                  </SidebarMenu>
                </SidebarGroup>
              ) : null}
            </SidebarContent>

            <SidebarFooter className="max-md:hidden">
              <SidebarMenu>
                <SidebarMenuItem>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                      <SquareAvatar initials={initials} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{userName ?? roleLabel}</span>
                        {userName ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {roleLabel}
                          </span>
                        ) : (
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {shell.principalId}
                          </span>
                        )}
                      </span>
                      <Icon icon={ArrowUp01Icon} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-64" side="top">
                      <UserMenuItems shell={shell} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          </>
        }
      >
        {organization.status === "active" ? null : (
          <div className="mb-6">
            <Badge color={statusColor(organization.status)}>
              Organization {statusLabel(organization.status).toLowerCase()}
            </Badge>
          </div>
        )}
        <OrganizationNotices access={access} organizationId={organization.id} />
        {children}
      </ConsoleShell>
      {creatingOrganization ? (
        <CreateOrganizationDialog onClose={() => setCreatingOrganization(false)} />
      ) : null}
    </>
  );
}
