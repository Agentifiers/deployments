import {
  Activity01Icon,
  AiBrain01Icon,
  ArrowLeft02Icon,
  Building03Icon,
  Rocket01Icon,
  ServerStack01Icon,
  ShieldKeyIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { INSTALL_COPY, type InstallCopy } from "../../edition.ts";
import type { ConsoleRoute } from "../../navigation.ts";
import { Heading } from "@/components/ui/heading";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ConsoleShell, SidebarLink } from "../organization-shell.tsx";
import { SignOutButton } from "../sign-out.tsx";

interface SystemPage {
  readonly icon: IconSvgElement;
  readonly label: string;
  readonly match: "exact" | "within";
  readonly to: ConsoleRoute;
}

export const SYSTEM_PAGES: readonly SystemPage[] = [
  { icon: ServerStack01Icon, label: "Overview", match: "exact", to: "/system" },
  { icon: Rocket01Icon, label: "Deployments", match: "exact", to: "/system/deployments" },
  { icon: Activity01Icon, label: "Health", match: "exact", to: "/system/health" },
  { icon: AiBrain01Icon, label: "Model providers", match: "exact", to: "/system/model-providers" },
  { icon: Building03Icon, label: "Organizations", match: "within", to: "/system/organizations" },
  { icon: UserGroupIcon, label: "People", match: "within", to: "/system/people" },
  { icon: ShieldKeyIcon, label: "Operator access", match: "exact", to: "/system/operator-access" },
];

function isCurrent(page: SystemPage, pathname: string) {
  const path = pathname.replace(/\/$/u, "") || "/";
  return page.match === "exact" ? path === page.to : path.startsWith(page.to);
}

/**
 * The install-operator area. Its pages render only for a platform administrator, the one caller
 * the system API admits; anyone else sees why the area is empty.
 */
export function SystemShell({
  children,
  copy = INSTALL_COPY["self-hosted"],
  platformAdministrator,
}: Readonly<{ children: ReactNode; copy?: InstallCopy; platformAdministrator: boolean }>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <ConsoleShell
      actions={
        <div className="md:hidden">
          <SignOutButton />
        </div>
      }
      sidebar={
        <>
          <SidebarHeader>
            <SidebarMenu>
              <SidebarLink href="/">
                <Icon icon={ArrowLeft02Icon} />
                <span>Organizations</span>
              </SidebarLink>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            {platformAdministrator ? (
              <SidebarGroup>
                <SidebarGroupLabel render={<h3 />}>System</SidebarGroupLabel>
                <SidebarMenu>
                  {SYSTEM_PAGES.map((page) => (
                    <SidebarLink current={isCurrent(page, pathname)} href={page.to} key={page.to}>
                      <Icon icon={page.icon} />
                      <span>{page.label}</span>
                    </SidebarLink>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
          </SidebarContent>
          <SidebarFooter className="max-md:hidden">
            <SignOutButton />
          </SidebarFooter>
        </>
      }
    >
      {platformAdministrator ? (
        children
      ) : (
        <div className="space-y-4">
          <Heading>System</Heading>
          <Text>{copy.systemAccessDenied}</Text>
        </div>
      )}
    </ConsoleShell>
  );
}
