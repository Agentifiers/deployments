import { Key01Icon, PlusSignIcon, UserAccountIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import {
  allowedAccountActions,
  allowedKeyActions,
  DIRECTORY_VIEWS,
  keyState,
  type ApiKeyView,
  type DirectoryView,
  type ServiceAccountView,
} from "../../api-keys/directory.ts";
import { apiKeyDirectoryPagesQuery } from "../../data/api-key-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { AccessDialogs, type AccessDialog } from "./api-key-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const VIEW_LABELS: Readonly<Record<DirectoryView, string>> = { active: "Active", all: "All" };

export function DirectoryViewToggle({
  onChange,
  value,
}: Readonly<{ onChange: (view: DirectoryView) => void; value: DirectoryView }>) {
  return (
    <SingleToggleGroup
      aria-label="Service accounts shown"
      onValueChange={(next) => {
        const view = oneOf(DIRECTORY_VIEWS, next);
        if (view) onChange(view);
      }}
      size="sm"
      value={value}
    >
      {DIRECTORY_VIEWS.map((view) => (
        <ToggleGroupItem key={view} value={view}>
          {VIEW_LABELS[view]}
        </ToggleGroupItem>
      ))}
    </SingleToggleGroup>
  );
}

export function ScopeChips({
  limit = Number.POSITIVE_INFINITY,
  scopes,
}: Readonly<{ limit?: number; scopes: readonly string[] }>) {
  const hidden = scopes.length - limit;
  return (
    <span className="flex flex-wrap gap-1" title={scopes.join(" ")}>
      {scopes.slice(0, limit).map((scope) => (
        <Code key={scope}>{scope}</Code>
      ))}
      {hidden > 0 ? <span className="text-xs/5 text-muted-foreground">+{hidden} more</span> : null}
    </span>
  );
}

export function ApiKeyDirectory({
  scope,
  view,
}: Readonly<{ scope: EnvironmentScope; view: DirectoryView }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = apiKeyDirectoryPagesQuery(scope, view);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const [dialog, setDialog] = useState<AccessDialog>();
  const accounts = data.pages.flatMap((page) => page.accounts);
  const unassigned = data.pages.flatMap((page) => page.unassigned);
  const hidden = data.pages[0]?.hidden ?? 0;
  const now = new Date();
  const createAccount = shell.access.createServiceAccount ? (
    <Button onClick={() => setDialog({ kind: "create-account" })}>
      <Icon icon={PlusSignIcon} />
      Create service account
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Text>
          Service accounts are the identities your backends authenticate as. Each API key belongs to
          one account and holds some or all of its scopes.
        </Text>
        {createAccount ? <div className="ml-auto">{createAccount}</div> : null}
      </div>
      {view === "active" ? (
        <Text>
          {hidden > 0
            ? `Revoked keys and ${formatExact(hidden)} disabled or archived service ${hidden === 1 ? "account" : "accounts"} are hidden.`
            : "Revoked keys are hidden."}
        </Text>
      ) : null}
      {accounts.length === 0 && unassigned.length === 0 ? (
        <ListEmpty
          action={createAccount}
          docs="/docs/capabilities/service-accounts-and-api-keys"
          icon={UserAccountIcon}
          title={hidden > 0 ? "No active service accounts" : "No service accounts"}
        >
          Create one, then issue it an API key.
        </ListEmpty>
      ) : null}
      {accounts.map(({ account, keys }) => {
        const actions = allowedAccountActions(account, shell.access);
        return (
          <section className="flex flex-col gap-4" key={account.id}>
            <div className="flex flex-wrap items-center gap-3">
              <Subheading>{account.name}</Subheading>
              <StatusBadge status={account.status} />
              <PublicId value={account.id} />
              <div className="ml-auto flex gap-3">
                {actions.includes("issue-key") ? (
                  <Button
                    onClick={() => setDialog({ account, kind: "issue-key" })}
                    variant="outline"
                  >
                    <Icon icon={Key01Icon} />
                    Issue key
                  </Button>
                ) : null}
                {actions.includes("revoke") ? (
                  <Button
                    onClick={() =>
                      setDialog({
                        account,
                        activeKeys: keys.filter((key) => keyState(key, account, now) === "active")
                          .length,
                        kind: "revoke-account",
                      })
                    }
                    variant="ghost"
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            </div>
            {account.description ? <Text>{account.description}</Text> : null}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm/6 text-muted-foreground">
              <ScopeChips scopes={account.scopes} />
              <span>
                Created <Timestamp value={account.createdAt} />
              </span>
            </div>
            {keys.length === 0 ? (
              <Text>No API keys.</Text>
            ) : (
              <KeyTable
                access={shell.access}
                account={account}
                keys={keys}
                now={now}
                onDialog={setDialog}
                scope={scope}
              />
            )}
          </section>
        );
      })}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
      {unassigned.length > 0 ? (
        <section className="flex flex-col gap-4">
          <Subheading>Keys of unlisted service accounts</Subheading>
          <Text>The service account list did not include the accounts these keys belong to.</Text>
          <KeyTable
            access={shell.access}
            account={undefined}
            keys={unassigned}
            now={now}
            onDialog={setDialog}
            scope={scope}
          />
        </section>
      ) : null}
      <AccessDialogs dialog={dialog} onDialog={setDialog} scope={scope} />
    </div>
  );
}

function KeyTable({
  access,
  account,
  keys,
  now,
  onDialog,
  scope,
}: Readonly<{
  access: OperationAccess;
  account: ServiceAccountView | undefined;
  keys: readonly ApiKeyView[];
  now: Date;
  onDialog: (dialog: AccessDialog) => void;
  scope: EnvironmentScope;
}>) {
  return (
    <Table dense striped>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Prefix</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((apiKey) => {
          const state = keyState(apiKey, account, now);
          const actions = allowedKeyActions(state, access);
          return (
            <TableRow key={apiKey.id}>
              <TableCell>
                <TextLink href={`${environmentPath(scope)}/api-keys/${apiKey.id}`}>
                  {apiKey.name}
                </TextLink>
              </TableCell>
              <TableCell>
                <Code>{apiKey.keyPrefix}</Code>
              </TableCell>
              <TableCell>
                <ScopeChips limit={3} scopes={apiKey.scopes} />
              </TableCell>
              <TableCell>
                <StatusBadge status={state} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {apiKey.expiresAt ? <Timestamp value={apiKey.expiresAt} /> : "Never"}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {actions.includes("rotate") ? (
                    <Button
                      onClick={() => onDialog({ account, apiKey, kind: "rotate-key" })}
                      variant="ghost"
                    >
                      Rotate
                    </Button>
                  ) : null}
                  {actions.includes("revoke") ? (
                    <Button
                      onClick={() => onDialog({ apiKey, kind: "revoke-key" })}
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
