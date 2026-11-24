import {
  CheckmarkCircle02Icon,
  Key01Icon,
  Link01Icon,
  RefreshIcon,
  Unlink01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  connectionActions,
  deniedToolsRemedy,
  grantableScopes,
  grantImpact,
  grantRows,
  verificationOutcome,
  type CapabilityView,
  type ConnectionAction,
  type GrantRow,
  type PinningDeploymentView,
  type WorkspaceView,
} from "../../connections/connection-state.ts";
import { connectionGrantsQuery } from "../../data/agent-runtime-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  connectionDetailQuery,
  pinningDeploymentsQuery,
  providerCatalogQuery,
  rereadOnConflict,
  verificationQuery,
  workspacesQuery,
} from "../../data/connection-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutAction, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { RevokeConnectionDialog, VerifyConnectionDialog } from "./connection-dialogs.tsx";
import { RotateCredentialDialog } from "./credential-dialogs.tsx";
import { CreateGrantDialog, RevokeGrantDialog } from "./grant-dialogs.tsx";
import { GrantWorkspace } from "./grant-workspace.tsx";
import { VendorToolSync } from "./vendor-tool-sync.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_CONTROLS: Readonly<
  Record<ConnectionAction, { readonly icon: IconSvgElement; readonly label: string }>
> = {
  grant: { icon: Link01Icon, label: "Grant" },
  reauthorize: { icon: RefreshIcon, label: "Reauthorize" },
  revoke: { icon: Unlink01Icon, label: "Revoke" },
  rotate: { icon: Key01Icon, label: "Rotate credential" },
  verify: { icon: CheckmarkCircle02Icon, label: "Verify" },
};

function ScopeList({ scopes }: Readonly<{ scopes: readonly string[] }>) {
  return scopes.length === 0 ? "None" : <Code>{scopes.join(", ")}</Code>;
}

function LastVerification({
  scope,
  verificationId,
}: Readonly<{ scope: EnvironmentScope; verificationId: string }>) {
  const { data: verification } = useSuspenseQuery(verificationQuery(scope, verificationId));
  const outcome = verificationOutcome(verification);
  return (
    <Callout variant={verification.status === "failed" ? "destructive" : "default"}>
      <CalloutTitle>
        Verification {verification.status}
        {verification.completedAt ? (
          <>
            {" "}
            at <Timestamp value={verification.completedAt} />
          </>
        ) : null}
      </CalloutTitle>
      <CalloutDescription>
        {outcome.problem ? <p>{outcome.problem}</p> : null}
        {outcome.method ? (
          <p>
            Method <Code>{outcome.method}</Code>
            {outcome.scopes.length > 0 ? (
              <>
                , scopes <Code>{outcome.scopes.join(", ")}</Code>
              </>
            ) : null}
            .
          </p>
        ) : null}
      </CalloutDescription>
    </Callout>
  );
}

function CapabilityTable({ capabilities }: Readonly<{ capabilities: readonly CapabilityView[] }>) {
  if (capabilities.length === 0) {
    return <Text>No capability yet. A successful verification records one.</Text>;
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead className="text-right">Verification version</TableHead>
          <TableHead>ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {capabilities.map((capability) => (
          <TableRow key={capability.id}>
            <TableCell>
              <StatusBadge status={capability.status} />
            </TableCell>
            <TableCell className="max-w-96 whitespace-normal">
              <ScopeList scopes={capability.scopes} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(capability.verificationVersion)}
            </TableCell>
            <TableCell>
              <PublicId value={capability.id} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GrantTable({
  canRevoke,
  deployments,
  onRevoke,
  rows,
  scope,
  workspaces,
}: Readonly<{
  canRevoke: boolean;
  deployments: readonly PinningDeploymentView[];
  onRevoke: (row: GrantRow) => void;
  rows: readonly GrantRow[];
  scope: EnvironmentScope;
  workspaces: readonly WorkspaceView[];
}>) {
  if (rows.length === 0)
    return <Text>No grants. A grant lets agent runs in one workspace use this connection.</Text>;
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const agents = new Map<string, string>(
    deployments.map((deployment) => [deployment.id, deployment.agentDefinitionId]),
  );
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Workspace</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Pinned by</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>ID</TableHead>
          {canRevoke ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.grant.id}>
            <TableCell>
              <GrantWorkspace names={workspaceNames} workspaceId={row.grant.workspaceId} />
            </TableCell>
            <TableCell>
              <StatusBadge status={row.grant.status} />
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal">
              <ScopeList scopes={row.grant.scopes} />
            </TableCell>
            <TableCell>
              {row.uses.length === 0 ? (
                "None"
              ) : (
                <ul className="flex flex-col gap-1">
                  {row.uses.map((use) => {
                    const definitionId = agents.get(use.deploymentId);
                    return (
                      <li
                        className="flex items-center gap-2"
                        key={`${use.deploymentId}:${use.toolName}`}
                      >
                        <PublicId value={use.deploymentId} />
                        {definitionId ? (
                          <TextLink href={`${environmentPath(scope)}/agents/${definitionId}/tools`}>
                            <Code>{use.toolName}</Code>
                          </TextLink>
                        ) : (
                          <Code>{use.toolName}</Code>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={row.grant.createdAt} />
            </TableCell>
            <TableCell>
              <PublicId value={row.grant.id} />
            </TableCell>
            {canRevoke ? (
              <TableCell className="text-right">
                {row.grant.status === "active" ? (
                  <Button onClick={() => onRevoke(row)} variant="ghost">
                    Revoke
                  </Button>
                ) : null}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ConnectionDetail({
  connectionId,
  onVerified,
  scope,
  verificationId,
}: Readonly<{
  connectionId: string;
  onVerified: (verificationId: string) => void;
  scope: EnvironmentScope;
  verificationId: string | undefined;
}>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { access } = shell;
  const detailQuery = connectionDetailQuery(scope, connectionId);
  const { data: detail } = useSuspenseQuery(detailQuery);
  const grantsQuery = useQuery({
    ...connectionGrantsQuery(scope),
    enabled: access.listConnectionGrants,
  });
  const deploymentsQuery = useQuery({
    ...pinningDeploymentsQuery(scope),
    enabled: access.listAgentDeployments,
  });
  const workspaces = useQuery({ ...workspacesQuery(scope), enabled: access.listWorkspaces });
  const catalog = useQuery(providerCatalogQuery());
  const [dialog, setDialog] = useState<ConnectionAction>();
  const [revokingGrant, setRevokingGrant] = useState<GrantRow>();
  const { capabilities, connection } = detail;
  const grants = grantsQuery.data ?? [];
  const deployments = deploymentsQuery.data ?? [];
  const actions = connectionActions(connection, access);
  const scopes = grantableScopes(connection, capabilities);
  const rows = grantRows(connection.id, grants, deployments);
  const denied = grantImpact(connection.id, grants, deployments, "revoked").deployments;
  const impactLoading = grantsQuery.isLoading || deploymentsQuery.isLoading;
  const provider = catalog.data?.find((entry) => entry.key === connection.providerKey);
  const rebindPath = `${environmentPath(scope)}/connections/${connection.id}/rebind`;
  const reauthorizePath = `${rebindPath}?kind=reauthorize`;
  const close = () => setDialog(undefined);
  const submit = rereadOnConflict(queryClient, detailQuery.queryKey);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{connection.displayName}</Heading>
        <StatusBadge status={connection.status} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {actions.map((action) => {
            const { icon, label } = ACTION_CONTROLS[action];
            const content = (
              <>
                <Icon icon={icon} />
                {label}
              </>
            );
            if (action === "revoke") {
              return (
                <Button
                  variant="destructive"
                  disabled={impactLoading}
                  key={action}
                  onClick={() => setDialog(action)}
                >
                  {content}
                </Button>
              );
            }
            if (action === "reauthorize") {
              return (
                <Button href={reauthorizePath} key={action} variant="outline">
                  {content}
                </Button>
              );
            }
            const blocked = action === "grant" && scopes === undefined;
            return (
              <Button
                disabled={blocked || (action === "rotate" && impactLoading)}
                key={action}
                onClick={() => setDialog(action)}
                variant="outline"
                title={blocked ? "Verify first" : undefined}
              >
                {content}
                {blocked ? (
                  <span className="text-xs text-muted-foreground">Verify first</span>
                ) : null}
              </Button>
            );
          })}
        </div>
      </div>
      {denied > 0 ? (
        <Callout variant="destructive">
          <CalloutTitle>
            {formatExact(denied)} {denied === 1 ? "deployment has" : "deployments have"} tools
            denied
          </CalloutTitle>
          <CalloutDescription>
            They pin revoked grants of this connection. The runtime denies those tools until the
            deployments pin an active grant.
          </CalloutDescription>
          {deniedToolsRemedy(connection) === "reauthorize" && actions.includes("reauthorize") ? (
            <CalloutAction>
              <TextLink href={reauthorizePath}>Reauthorize</TextLink>
            </CalloutAction>
          ) : deniedToolsRemedy(connection) === "restore" ? (
            <CalloutAction>
              <TextLink href={rebindPath}>Continue restoring</TextLink>
            </CalloutAction>
          ) : null}
        </Callout>
      ) : null}
      {verificationId ? (
        <SectionBoundary fallback={null} resetKey={verificationId}>
          <LastVerification scope={scope} verificationId={verificationId} />
        </SectionBoundary>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={connection.id} />
        </DescriptionDetails>
        <DescriptionTerm>Provider</DescriptionTerm>
        <DescriptionDetails>
          {provider ? `${provider.displayName} ` : null}
          <Code>{connection.providerKey}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Auth method</DescriptionTerm>
        <DescriptionDetails>{connection.authMethod}</DescriptionDetails>
        <DescriptionTerm>External account</DescriptionTerm>
        <DescriptionDetails>
          {connection.externalAccountName ??
            connection.externalAccountId ??
            "Not known until verified"}
        </DescriptionDetails>
        <DescriptionTerm>Scopes</DescriptionTerm>
        <DescriptionDetails>
          <ScopeList scopes={connection.scopes} />
        </DescriptionDetails>
        <DescriptionTerm>Last verified</DescriptionTerm>
        <DescriptionDetails>
          {connection.lastVerifiedAt ? <Timestamp value={connection.lastVerifiedAt} /> : "Never"}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={connection.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={connection.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Capabilities</Subheading>
        <CapabilityTable capabilities={capabilities} />
      </section>
      {provider?.route === "vendor_mcp" && access.syncConnectionTools ? (
        <VendorToolSync connectionId={connection.id} scope={scope} />
      ) : null}
      {access.listConnectionGrants ? (
        <section className="flex flex-col gap-4">
          <Subheading>Grants</Subheading>
          <GrantTable
            canRevoke={access.revokeConnectionGrant}
            deployments={deployments}
            onRevoke={setRevokingGrant}
            rows={rows}
            scope={scope}
            workspaces={workspaces.data ?? []}
          />
        </section>
      ) : null}
      {actions.includes("verify") ? (
        <VerifyConnectionDialog
          connection={connection}
          onClose={close}
          onVerified={(verification) => onVerified(verification.id)}
          open={dialog === "verify"}
          scope={scope}
        />
      ) : null}
      {actions.includes("rotate") ? (
        <RotateCredentialDialog
          connection={connection}
          deployments={deployments}
          grants={grants}
          onClose={close}
          onSubmit={submit}
          open={dialog === "rotate"}
          scope={scope}
        />
      ) : null}
      {actions.includes("grant") && scopes !== undefined ? (
        <CreateGrantDialog
          connection={connection}
          grantableScopes={scopes}
          onClose={close}
          open={dialog === "grant"}
          scope={scope}
        />
      ) : null}
      {actions.includes("revoke") ? (
        <RevokeConnectionDialog
          connection={connection}
          deployments={deployments}
          grants={grants}
          onClose={close}
          onSubmit={submit}
          open={dialog === "revoke"}
          scope={scope}
        />
      ) : null}
      {revokingGrant ? (
        <RevokeGrantDialog
          onClose={() => setRevokingGrant(undefined)}
          row={revokingGrant}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
