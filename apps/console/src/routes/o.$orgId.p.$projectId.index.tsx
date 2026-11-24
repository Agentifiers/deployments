import { PlusSignIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { EnvironmentTypeBadge } from "../components/organization-shell.tsx";
import { CreateEnvironmentDialog } from "../components/tenancy/create-dialogs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { StatusBadge } from "@/components/status-badge";

export const Route = createFileRoute("/o/$orgId/p/$projectId/")({
  component: ProjectPage,
});

function ProjectPage() {
  const { orgId, projectId } = Route.useParams();
  const {
    data: { access, projects },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const [creating, setCreating] = useState(false);
  const entry = projects.find((candidate) => candidate.project.id === projectId);
  if (!entry) throw notFound();
  const { environments, project } = entry;
  const base = `/o/${orgId}/p/${projectId}`;
  const active = project.status === "active";
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{project.name}</Heading>
        <StatusBadge status={project.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {access.getProject ? (
            <Button href={`${base}/settings`} variant="outline">
              <Icon icon={Settings02Icon} />
              Project settings
            </Button>
          ) : null}
          {access.createEnvironment && active ? (
            <Button onClick={() => setCreating(true)}>
              <Icon icon={PlusSignIcon} />
              Create environment
            </Button>
          ) : null}
        </div>
      </div>
      {environments.length === 0 ? (
        <Text>No environments in this project.</Text>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Settings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((environment) => (
              <TableRow key={environment.id}>
                <TableCell>
                  {environment.status === "active" ? (
                    <Link className="font-medium underline" href={`${base}/e/${environment.id}`}>
                      {environment.name}
                    </Link>
                  ) : (
                    environment.name
                  )}
                </TableCell>
                <TableCell>
                  <Code>{environment.slug}</Code>
                </TableCell>
                <TableCell>
                  <EnvironmentTypeBadge type={environment.type} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={environment.status} />
                </TableCell>
                <TableCell className="text-right">
                  {environment.status === "active" ? (
                    <Link
                      className="text-sm/6 underline"
                      href={`${base}/e/${environment.id}/settings`}
                    >
                      Settings
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {creating ? (
        <CreateEnvironmentDialog
          onClose={() => setCreating(false)}
          organizationId={orgId}
          project={project}
        />
      ) : null}
    </div>
  );
}
