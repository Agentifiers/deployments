import {
  ArrowRight01Icon,
  Building03Icon,
  PlusSignIcon,
  SecurityCheckIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationsQuery, platformAdministratorQuery } from "../../data/console-queries.ts";
import { INSTALL_COPY, showsSystem, useConsoleEdition } from "../../edition.ts";
import { Icon } from "../icon.tsx";
import { SignOutButton } from "../sign-out.tsx";
import { CreateOrganizationDialog } from "./create-dialogs.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Heading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { StatusBadge } from "@/components/status-badge";

/**
 * The caller's organizations, each linking to its overview. The System link for platform
 * administrators shows only when the edition mounts `/system`. Its route loader should ensure
 * `organizationsQuery()`.
 */
export function OrganizationPicker() {
  const edition = useConsoleEdition();
  const operatorActions = showsSystem(edition);
  const { data: organizations } = useSuspenseQuery(organizationsQuery());
  const { data: platformAdministrator } = useQuery({
    ...platformAdministratorQuery(),
    enabled: operatorActions,
  });
  const [creating, setCreating] = useState(false);
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 lg:py-16">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{organizations.length === 0 ? "Organizations" : "Choose an organization"}</Heading>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {operatorActions && platformAdministrator === true ? (
            <Button href="/system" variant="outline">
              <Icon icon={ServerStack01Icon} />
              System
            </Button>
          ) : null}
          {organizations.length === 0 ? null : (
            <Button onClick={() => setCreating(true)}>
              <Icon icon={PlusSignIcon} />
              Create organization
            </Button>
          )}
          <Button href="/account" variant="outline">
            <Icon icon={SecurityCheckIcon} />
            Account security
          </Button>
          <SignOutButton />
        </div>
      </div>
      {organizations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={Building03Icon} />
            </EmptyMedia>
            <EmptyTitle>No organizations yet</EmptyTitle>
            <EmptyDescription>{INSTALL_COPY[edition.install].noOrganizations}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setCreating(true)}>
              <Icon icon={PlusSignIcon} />
              Create organization
            </Button>
            <EmptyDescription>Have an invitation? Open the link from your email.</EmptyDescription>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="divide-y divide-border rounded-lg bg-card shadow-xs ring-1 ring-border">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60"
                href={`/o/${organization.id}`}
              >
                <Avatar aria-hidden className="rounded-lg after:rounded-lg">
                  <AvatarFallback className="rounded-lg">
                    {organization.name.slice(0, 2)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm/6 font-medium">{organization.name}</span>
                  <span className="block truncate text-xs/5 text-muted-foreground">
                    {organization.slug}
                  </span>
                </span>
                {organization.status === "active" ? null : (
                  <StatusBadge status={organization.status} />
                )}
                <Icon icon={ArrowRight01Icon} className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating ? <CreateOrganizationDialog onClose={() => setCreating(false)} /> : null}
    </main>
  );
}
