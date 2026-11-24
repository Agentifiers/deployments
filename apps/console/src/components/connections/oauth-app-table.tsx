import { Key01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { appActions, type OAuthAppAction, type OAuthAppView } from "../../connections/oauth.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { providerCatalogQuery } from "../../data/connection-queries.ts";
import { oauthAppsQuery } from "../../data/oauth-app-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import {
  ArchiveOAuthAppDialog,
  RegisterOAuthAppDialog,
  RotateOAuthAppSecretDialog,
} from "./oauth-app-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

interface OpenDialog {
  readonly action: OAuthAppAction;
  readonly app: OAuthAppView;
}

export function OAuthAppList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { access } = shell;
  const { data } = useSuspenseQuery(oauthAppsQuery(scope));
  const catalog = useQuery(providerCatalogQuery());
  const [registering, setRegistering] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>();
  const { appConnections, apps, callbackOrigin, complete } = data;
  const providerName = (key: string) =>
    catalog.data?.find((entry) => entry.key === key)?.displayName ?? key;
  const usage = (app: OAuthAppView) =>
    appConnections.filter((connection) => connection.providerApplicationId === app.id);
  const close = () => setDialog(undefined);
  const dialogEntry = catalog.data?.find((entry) => entry.key === dialog?.app.providerKey);
  const register = access.createProviderApplication ? (
    <Button onClick={() => setRegistering(true)}>
      <Icon icon={PlusSignIcon} />
      Register OAuth app
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Text className="max-w-3xl">
          An OAuth app is the client you register with a provider. Connecting a provider over OAuth
          signs in through the environment's active app for it.
        </Text>
        {register ? <div className="ml-auto">{register}</div> : null}
      </div>
      {apps.length === 0 ? (
        <ListEmpty
          action={register}
          docs="/docs/capabilities/providers-and-connections"
          icon={Key01Icon}
          title="No OAuth apps"
        >
          Providers that sign in over OAuth need an app here unless the platform registers its own
          client with the provider.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Connections</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>ID</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.id}>
                <TableCell>
                  {app.displayName}
                  <div className="text-xs/5 text-muted-foreground">
                    {providerName(app.providerKey)} <Code>{app.providerKey}</Code>
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={app.status} />
                </TableCell>
                <TableCell className="max-w-56 truncate font-mono text-xs">
                  {app.clientId}
                </TableCell>
                <TableCell>
                  {usage(app).length}
                  {complete ? null : "+"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={app.createdAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={app.id} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {appActions(app, access).map((action) => (
                    <Button key={action} onClick={() => setDialog({ action, app })} variant="ghost">
                      {action === "archive" ? "Archive" : "Rotate secret"}
                    </Button>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {access.createProviderApplication && registering ? (
        <RegisterOAuthAppDialog
          callbackOrigin={callbackOrigin}
          onClose={() => setRegistering(false)}
          open
          scope={scope}
        />
      ) : null}
      {dialog?.action === "rotate" ? (
        <RotateOAuthAppSecretDialog
          app={dialog.app}
          callbackOrigin={callbackOrigin}
          connections={{ complete, items: usage(dialog.app) }}
          oauth={dialogEntry?.access === "oauth" ? dialogEntry.oauth : undefined}
          onClose={close}
          open
          scope={scope}
        />
      ) : null}
      {dialog?.action === "archive" ? (
        <ArchiveOAuthAppDialog
          app={dialog.app}
          connections={{ complete, items: usage(dialog.app) }}
          onClose={close}
          open
          scope={scope}
        />
      ) : null}
    </div>
  );
}
