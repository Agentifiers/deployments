import { Folder01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Icon } from "../components/icon.tsx";
import { ListEmpty } from "../components/list-controls.tsx";
import { Timestamp } from "../components/observability/panels.tsx";
import { PublicId } from "../components/public-id.tsx";
import { EnvironmentTypeBadge } from "../components/organization-shell.tsx";
import {
  CreateEnvironmentDialog,
  CreateProjectDialog,
} from "../components/tenancy/create-dialogs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { organizationStandingQuery } from "../data/organization-account-queries.ts";
import { nextSetupStep } from "../tenancy/setup.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Heading, Subheading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { StatusBadge } from "@/components/status-badge";

export const Route = createFileRoute("/o/$orgId/")({
  component: OrganizationOverview,
});

type OverviewDialog =
  | { readonly kind: "create-project" }
  | {
      readonly kind: "create-environment";
      readonly project: { readonly id: string; readonly name: string };
    };

/** The next setup step gets the one solid button; every other create action is outlined. */
function SetupButton({
  children,
  onClick,
  primary,
}: Readonly<{ children: ReactNode; onClick: () => void; primary: boolean }>) {
  return (
    <Button onClick={onClick} variant={primary ? "default" : "outline"}>
      {children}
    </Button>
  );
}

function OrganizationOverview() {
  const { orgId } = Route.useParams();
  const {
    data: { access, organization, projects },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const { data: standing } = useQuery({
    ...organizationStandingQuery(orgId),
    enabled: access.getOrganizationStanding,
  });
  const status = standing?.state === "suspended" ? "suspended" : organization.status;
  // "active" is only true with a standing read behind it; any other lifecycle status stands alone.
  const statusUnknown =
    status === "active" && access.getOrganizationStanding && standing === undefined;
  const [dialog, setDialog] = useState<OverviewDialog>();
  const step = nextSetupStep(projects);
  const createProject = access.createProject ? (
    <SetupButton
      onClick={() => setDialog({ kind: "create-project" })}
      primary={step.kind === "create-project"}
    >
      <Icon icon={PlusSignIcon} />
      Create project
    </SetupButton>
  ) : undefined;
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{organization.name}</Heading>
        {statusUnknown ? null : <StatusBadge status={status} />}
      </div>

      <DescriptionList>
        <DescriptionTerm>Organization ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId full value={organization.id} />
        </DescriptionDetails>
        <DescriptionTerm>Slug</DescriptionTerm>
        <DescriptionDetails>{organization.slug}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={organization.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={organization.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Projects and environments</Subheading>
          {projects.length > 0 && createProject ? (
            <div className="ml-auto">{createProject}</div>
          ) : null}
        </div>
        <Separator />
        {projects.length === 0 ? (
          createProject ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Icon icon={Folder01Icon} />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Create a project, then an environment in it, to start deploying agents.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>{createProject}</EmptyContent>
            </Empty>
          ) : (
            <ListEmpty
              docs="/docs/capabilities/tenancy"
              icon={Folder01Icon}
              title="No projects yet"
            >
              An owner or admin can create projects.
            </ListEmpty>
          )
        ) : (
          projects.map(({ environments, project }) => (
            <div className="space-y-2" key={project.id}>
              <div className="flex items-center gap-2">
                <Link
                  className="text-sm/6 font-semibold hover:underline"
                  href={`/o/${organization.id}/p/${project.id}`}
                >
                  {project.name}
                </Link>
                {project.status === "active" ? null : <StatusBadge status={project.status} />}
                {access.createEnvironment && project.status === "active" ? (
                  <div className="ml-auto">
                    <SetupButton
                      onClick={() => setDialog({ kind: "create-environment", project })}
                      primary={step.kind === "create-environment" && step.projectId === project.id}
                    >
                      <Icon icon={PlusSignIcon} />
                      Create environment
                    </SetupButton>
                  </div>
                ) : null}
              </div>
              {environments.length === 0 ? (
                <Text>No environments.</Text>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {environments.map((environment) => (
                    <li key={environment.id}>
                      <Link
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm/6 ring-1 ring-border hover:bg-muted/60"
                        href={`/o/${organization.id}/p/${project.id}/e/${environment.id}`}
                      >
                        {environment.name}
                        <EnvironmentTypeBadge type={environment.type} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </section>
      <OverviewDialogs dialog={dialog} onDialog={setDialog} organizationId={organization.id} />
    </div>
  );
}

function OverviewDialogs({
  dialog,
  onDialog,
  organizationId,
}: Readonly<{
  dialog: OverviewDialog | undefined;
  onDialog: Dispatch<SetStateAction<OverviewDialog | undefined>>;
  organizationId: string;
}>) {
  // ActionDialog calls onClose right after onSuccess, so closing only the dialog that asked keeps
  // the environment dialog that project creation chains into.
  const close = (closing: OverviewDialog) =>
    onDialog((current) => (current === closing ? undefined : current));
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "create-project":
      return (
        <CreateProjectDialog
          onClose={() => close(dialog)}
          onCreated={(project) => onDialog({ kind: "create-environment", project })}
          organizationId={organizationId}
        />
      );
    case "create-environment":
      return (
        <CreateEnvironmentDialog
          onClose={() => close(dialog)}
          organizationId={organizationId}
          project={dialog.project}
        />
      );
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}
