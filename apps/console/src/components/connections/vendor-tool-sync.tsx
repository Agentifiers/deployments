import type { SyncConnectionToolsResponse } from "@deployments-ai/api-contract/providers";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { syncConnectionToolsFn } from "../../data/extension-mutations.ts";
import { invalidateExtensions } from "../../data/extension-queries.ts";
import {
  REJECTION_REASONS,
  syncDefaultAction,
  syncGroups,
  syncProblem,
} from "../../extensions/extension-state.ts";
import { PlatformApiError } from "../../errors.ts";
import type { EnvironmentScope } from "../../scope.ts";
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
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

type SyncResult = typeof SyncConnectionToolsResponse.Type;

export function VendorToolSync({
  connectionId,
  scope,
}: Readonly<{ connectionId: string; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SyncResult>();
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Tools</Subheading>
        <Button className="ml-auto" onClick={() => setOpen(true)} variant="outline">
          <Icon icon={RefreshIcon} />
          Sync tools
        </Button>
      </div>
      {result ? (
        <SyncChanges result={result} />
      ) : (
        <Text>
          Sync reads the vendor server&apos;s tool list and creates, updates, or archives the
          matching extensions in this environment.
        </Text>
      )}
      <ActionDialog
        confirmLabel="Sync tools"
        confirmation={typedConfirmation(environment.type, { phrase: "sync" })}
        description="The platform discovers the server's tools and reconciles this environment's extensions one tool at a time."
        onClose={() => setOpen(false)}
        onSuccess={(synced) => {
          setResult(synced);
          void invalidateExtensions(queryClient, scope);
        }}
        open={open}
        retryNotice="Sync applies tool by tool. Submit again to finish it with the same request key."
        run={(idempotencyKey: string) =>
          syncConnectionToolsFn({ data: { connectionId, idempotencyKey, scope } }).catch(
            (error: unknown) => {
              throw error instanceof PlatformApiError
                ? new PlatformApiError(error.operation, syncProblem(error.problem))
                : error;
            },
          )
        }
        successMessage={(synced) => `Synced ${synced.tools.length} remote tools`}
        title="Sync tools"
      />
    </section>
  );
}

function SyncChanges({ result }: Readonly<{ result: SyncResult }>) {
  if (result.tools.length === 0) {
    return <Text>The server advertised no tools.</Text>;
  }
  return (
    <div className="flex flex-col gap-3">
      <Text>
        Synced <Code>{result.providerKey}</Code> at <Timestamp value={result.syncedAt} />.
      </Text>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Change</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Remote tool</TableHead>
            <TableHead>Effect</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {syncGroups(result.tools).flatMap(({ change, tools }) =>
            tools.map((tool) => (
              <TableRow key={`${change}:${tool.remoteName}`}>
                <TableCell>
                  <StatusBadge status={change} />
                </TableCell>
                <TableCell className="font-mono">{tool.toolName ?? "None"}</TableCell>
                <TableCell className="font-mono">{tool.remoteName}</TableCell>
                <TableCell>
                  {tool.effect}
                  {change !== "rejected" &&
                  change !== "archived" &&
                  syncDefaultAction(tool) === "require_approval"
                    ? ", needs approval"
                    : ""}
                </TableCell>
                <TableCell>
                  {tool.reason === undefined ? null : (
                    <>
                      {REJECTION_REASONS[tool.reason] ?? tool.reason} <Code>{tool.reason}</Code>
                    </>
                  )}
                </TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>
    </div>
  );
}
