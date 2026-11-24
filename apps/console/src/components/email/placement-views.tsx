import { PlusSignIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { createPlacementFn, updatePlacementFn } from "../../data/agent-email-setup-mutations.ts";
import { invalidateAgentEmail, placementsQuery } from "../../data/agent-email-setup-queries.ts";
import {
  readPlacementDraft,
  type AgentEmailPlacement,
  type PlacementDraft,
} from "../../email/setup-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

type PlacementChange = {
  readonly kind: "default" | "disable";
  readonly placement: AgentEmailPlacement;
};

const usd = new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" });

export function PlacementList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: placements } = useSuspenseQuery(placementsQuery(scope));
  const [creating, setCreating] = useState(false);
  const [change, setChange] = useState<PlacementChange>();
  const { access } = shell;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Text>
          A placement is the region your agents&apos; outbound mail is sent from. Sending needs
          exactly one active default placement.
        </Text>
        {access.createAgentEmailPlacement ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Icon icon={PlusSignIcon} />
            Create placement
          </Button>
        ) : null}
      </div>
      {placements.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/agent-email"
          icon={ServerStack01Icon}
          title="No placements"
        />
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Default</TableHead>
              <TableHead className="text-right">Estimated monthly cost</TableHead>
              <TableHead>Last reconciled</TableHead>
              {access.updateAgentEmailPlacement ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {placements.map((placement) => (
              <TableRow key={placement.id}>
                <TableCell>
                  {placement.name}
                  {placement.dedicatedPool ? (
                    <div className="text-xs/5 text-muted-foreground">Dedicated IP pool</div>
                  ) : null}
                  {placement.reconciliationError ? (
                    <div className="text-xs/5 text-destructive">
                      {placement.reconciliationError}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={placement.status} />
                </TableCell>
                <TableCell>
                  {placement.region}
                  {placement.secondaryRegion ? ` + ${placement.secondaryRegion}` : ""}
                </TableCell>
                <TableCell>{placement.isDefault ? "Default" : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {placement.estimatedMonthlyCostCents === undefined
                    ? "—"
                    : usd.format(placement.estimatedMonthlyCostCents / 100)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {placement.lastReconciledAt ? (
                    <Timestamp value={placement.lastReconciledAt} />
                  ) : (
                    "Never"
                  )}
                </TableCell>
                {access.updateAgentEmailPlacement ? (
                  <TableCell className="text-right whitespace-nowrap">
                    {placement.status === "active" && !placement.isDefault ? (
                      <Button
                        onClick={() => setChange({ kind: "default", placement })}
                        variant="ghost"
                      >
                        Make default
                      </Button>
                    ) : null}
                    {placement.status === "active" ? (
                      <Button
                        onClick={() => setChange({ kind: "disable", placement })}
                        variant="ghost"
                      >
                        Disable
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {access.createAgentEmailPlacement ? (
        <CreatePlacementDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
      {access.updateAgentEmailPlacement ? (
        <ChangePlacementDialog change={change} onClose={() => setChange(undefined)} scope={scope} />
      ) : null}
    </div>
  );
}

const EMPTY_DRAFT: PlacementDraft = { isDefault: true, name: "", region: "", secondaryRegion: "" };

function CreatePlacementDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  useEffect(() => {
    if (open) setDraft(EMPTY_DRAFT);
  }, [open]);
  const read = readPlacementDraft(draft);
  return (
    <ActionDialog
      confirmLabel="Create placement"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: draft.name.trim() || "create",
      })}
      description="Creating a placement provisions SES configuration sets in AWS right away, and a secondary region adds a multi-region endpoint. The console never requests a dedicated IP pool."
      invalid={!read.ok}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createPlacementFn({ data: { body: read.ok ? read.body : draft, idempotencyKey, scope } })
      }
      successMessage={(placement) => `Created ${placement.name}`}
      title="Create placement"
    >
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      <Field>
        <Label>Region</Label>
        <Description>A default placement must use the hosted domain's region.</Description>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, region: event.target.value })}
          placeholder="us-east-2"
          value={draft.region}
        />
      </Field>
      <Field disabled={draft.isDefault}>
        <Label>Secondary region</Label>
        <Description>Optional failover region. Doubles the estimated cost.</Description>
        <Input
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, secondaryRegion: event.target.value })}
          value={draft.secondaryRegion}
        />
      </Field>
      <CheckboxField>
        <Checkbox
          checked={draft.isDefault}
          onCheckedChange={(isDefault) =>
            setDraft({
              ...draft,
              isDefault,
              secondaryRegion: isDefault ? "" : draft.secondaryRegion,
            })
          }
        />
        <Label>Default placement</Label>
        <Description>Inboxes without their own placement send through the default.</Description>
      </CheckboxField>
      {read.ok ? null : <Text>{read.message}</Text>}
    </ActionDialog>
  );
}

function ChangePlacementDialog({
  change,
  onClose,
  scope,
}: Readonly<{
  change: PlacementChange | undefined;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const disabling = change?.kind === "disable";
  const name = change?.placement.name ?? "";
  return (
    <ActionDialog
      confirmLabel={disabling ? "Disable placement" : "Make default"}
      confirmation={typedConfirmation(environment.type, { destructive: disabling, phrase: name })}
      description={
        disabling
          ? "Disabling deprovisions the placement's AWS resources. Inboxes that send through it stop sending until another placement serves them."
          : "Inboxes without their own placement send through the default. Only one placement can be the default."
      }
      destructive={disabling}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={change !== undefined}
      run={(idempotencyKey) =>
        updatePlacementFn({
          data: {
            body: disabling ? { status: "disabled" } : { isDefault: true },
            idempotencyKey,
            placementId: change?.placement.id ?? "",
            scope,
          },
        })
      }
      successMessage={disabling ? `Disabled ${name}` : `${name} is the default`}
      title={disabling ? `Disable ${name}` : `Make ${name} the default`}
    />
  );
}
