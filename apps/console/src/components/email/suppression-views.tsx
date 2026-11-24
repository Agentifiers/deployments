import { PlusSignIcon, UserBlock01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import {
  createSuppressionFn,
  removeSuppressionFn,
} from "../../data/agent-email-setup-mutations.ts";
import {
  invalidateAgentEmail,
  suppressionPagesQuery,
} from "../../data/agent-email-setup-queries.ts";
import { parseAddresses } from "../../email/addresses.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { RouteResponse } from "../../server/platform-api.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SectionBoundary } from "../section-boundary.tsx";

type Suppression = RouteResponse<"listAgentEmailSuppressions">["items"][number];

const FROM_PROVIDER: Readonly<Record<Suppression["reason"], boolean>> = {
  bounce: true,
  complaint: true,
  manual: false,
  policy: false,
};

export function SuppressionList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {shell.access.createAgentEmailSuppression ? (
        <div className="flex">
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            <Icon icon={PlusSignIcon} />
            Add suppression
          </Button>
        </div>
      ) : null}
      <SectionBoundary resetKey={scope.environmentId}>
        <SuppressionTable canRemove={shell.access.removeAgentEmailSuppression} scope={scope} />
      </SectionBoundary>
      {shell.access.createAgentEmailSuppression ? (
        <AddSuppressionDialog onClose={() => setAdding(false)} open={adding} scope={scope} />
      ) : null}
    </div>
  );
}

function SuppressionTable({
  canRemove,
  scope,
}: Readonly<{ canRemove: boolean; scope: EnvironmentScope }>) {
  const pagesQuery = suppressionPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const [removing, setRemoving] = useState<Suppression>();
  const suppressions = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {suppressions.length === 0 && hasNextPage ? null : suppressions.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/agent-email"
          icon={UserBlock01Icon}
          title="No suppressed addresses"
        >
          Sends to a suppressed address fail. Bounces and complaints add addresses automatically.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Added</TableHead>
              {canRemove ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppressions.map((suppression) => (
              <TableRow key={suppression.id}>
                <TableCell>{suppression.address}</TableCell>
                <TableCell>
                  <Badge color={FROM_PROVIDER[suppression.reason] ? "red" : "zinc"}>
                    {suppression.reason}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={suppression.createdAt} />
                </TableCell>
                {canRemove ? (
                  <TableCell className="text-right">
                    <Button onClick={() => setRemoving(suppression)} variant="ghost">
                      Remove
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
      {canRemove ? (
        <RemoveSuppressionDialog
          onClose={() => setRemoving(undefined)}
          scope={scope}
          suppression={removing}
        />
      ) : null}
    </div>
  );
}

function AddSuppressionDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState<"manual" | "policy">("manual");
  useEffect(() => {
    if (!open) return;
    setAddress("");
    setReason("manual");
  }, [open]);
  const parsed = parseAddresses(address, 1);
  const value = parsed.ok ? parsed.addresses[0] : undefined;
  return (
    <ActionDialog
      confirmLabel="Suppress"
      confirmation={typedConfirmation(environment.type, { phrase: value ?? "suppress" })}
      description="Every inbox in this environment refuses to send to a suppressed address."
      invalid={value === undefined}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createSuppressionFn({
          data: { body: { address: value ?? "", reason }, idempotencyKey, scope },
        })
      }
      successMessage={(created) => `Suppressed ${created.address}`}
      title="Add suppression"
    >
      <Field>
        <Label>Address</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setAddress(event.target.value)}
          type="email"
          value={address}
        />
      </Field>
      <Field>
        <Label>Reason</Label>
        <Description>
          Manual for one-off requests; policy for addresses your rules exclude.
        </Description>
        <NativeSelect
          onChange={(event) => setReason(event.target.value === "policy" ? "policy" : "manual")}
          value={reason}
        >
          <option value="manual">manual</option>
          <option value="policy">policy</option>
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

function RemoveSuppressionDialog({
  onClose,
  scope,
  suppression,
}: Readonly<{
  onClose: () => void;
  scope: EnvironmentScope;
  suppression: Suppression | undefined;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const address = suppression?.address ?? "";
  return (
    <ActionDialog
      confirmLabel="Remove"
      confirmation={typedConfirmation(environment.type, { destructive: true, phrase: address })}
      description={
        suppression && FROM_PROVIDER[suppression.reason]
          ? "This address bounced or complained. Removing it also clears it from the provider's suppression list, and sending to it again can hurt the environment's reputation."
          : "Inboxes can send to this address again."
      }
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={suppression !== undefined}
      run={(idempotencyKey) =>
        removeSuppressionFn({
          data: { idempotencyKey, scope, suppressionId: suppression?.id ?? "" },
        })
      }
      successMessage={`Removed ${address}`}
      title={`Remove ${address}`}
    />
  );
}
