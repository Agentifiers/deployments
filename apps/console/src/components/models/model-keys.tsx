import type { ModelCredentialProvider } from "@deployments-ai/api-contract/models";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import { removeModelKeyFn, setModelKeyFn } from "../../data/model-key-mutations.ts";
import { invalidateModelKeys, modelKeysQuery } from "../../data/model-key-queries.ts";
import { PROVIDER_LABELS } from "../../models/model-catalog-state.ts";
import { INSTALL_COPY, type InstallCopy } from "../../edition.ts";
import type { ModelKey } from "../../models/model-keys.ts";
import { ActionDialog } from "../action-dialog.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";

type KeyDialog = { readonly kind: "remove" | "set"; readonly key: ModelKey };

const STATE_BADGES = {
  "not-enabled": { color: "zinc", label: "Not enabled" },
  set: { color: "green", label: "Set" },
  unset: { color: "amber", label: "No key" },
} as const satisfies Record<ModelKey["state"], { color: string; label: string }>;

export function ModelKeys({
  access,
  copy = INSTALL_COPY["self-hosted"],
  organizationId,
}: Readonly<{ access: OperationAccess; copy?: InstallCopy; organizationId: string }>) {
  const { data: keys } = useSuspenseQuery(modelKeysQuery(organizationId));
  const [dialog, setDialog] = useState<KeyDialog>();
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Set</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => (
            <TableRow key={key.provider}>
              <TableCell className="font-medium">{PROVIDER_LABELS[key.provider]}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={STATE_BADGES[key.state].color}>
                    {STATE_BADGES[key.state].label}
                  </Badge>
                  {key.state === "set" ? (
                    <>
                      <Code>…{key.lastFour}</Code>
                      {key.label ? <span>{key.label}</span> : null}
                    </>
                  ) : null}
                  {key.state === "not-enabled" ? (
                    <span className="text-muted-foreground">
                      {copy.providerKeysNotAccepted(PROVIDER_LABELS[key.provider])}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>{key.state === "set" ? <Timestamp value={key.setAt} /> : "—"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {key.state !== "not-enabled" && access.putModelCredential ? (
                    <Button onClick={() => setDialog({ key, kind: "set" })} variant="outline">
                      {key.state === "set" ? "Replace" : "Add key"}
                    </Button>
                  ) : null}
                  {key.state === "set" && access.deleteModelCredential ? (
                    <Button onClick={() => setDialog({ key, kind: "remove" })} variant="ghost">
                      Remove
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {dialog?.kind === "set" ? (
        <SetModelKeyDialog
          onClose={() => setDialog(undefined)}
          organizationId={organizationId}
          provider={dialog.key.provider}
          replacing={dialog.key.state === "set"}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemoveModelKeyDialog
          operatorFundedPayer={copy.operatorFundedPayer}
          onClose={() => setDialog(undefined)}
          organizationId={organizationId}
          provider={dialog.key.provider}
        />
      ) : null}
    </>
  );
}

/** Mounted only while open, so the typed key is gone once the dialog closes. */
function SetModelKeyDialog({
  onClose,
  organizationId,
  provider,
  replacing,
}: Readonly<{
  onClose: () => void;
  organizationId: string;
  provider: ModelCredentialProvider;
  replacing: boolean;
}>) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const name = PROVIDER_LABELS[provider];
  const trimmedLabel = label.trim();
  return (
    <ActionDialog
      confirmLabel={replacing ? "Replace key" : "Save key"}
      description={`${name} checks the key before it is stored encrypted. It is never shown again.`}
      invalid={apiKey === ""}
      onClose={onClose}
      onSuccess={() => void invalidateModelKeys(queryClient, organizationId)}
      open
      run={(idempotencyKey) =>
        setModelKeyFn({
          data: {
            body: { apiKey, ...(trimmedLabel === "" ? {} : { label: trimmedLabel }) },
            idempotencyKey,
            provider,
            scope: { organizationId },
          },
        })
      }
      successMessage={`${name} key saved`}
      title={replacing ? `Replace the ${name} key` : `Add a key for ${name}`}
    >
      <Field>
        <Label>Model key</Label>
        <Input
          autoComplete="off"
          name="apiKey"
          onChange={(event) => setApiKey(event.target.value)}
          type="password"
          value={apiKey}
        />
      </Field>
      <Field>
        <Label>Label</Label>
        <Description>Optional. Helps you recognize the key later.</Description>
        <Input
          maxLength={100}
          name="label"
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
      </Field>
    </ActionDialog>
  );
}

function RemoveModelKeyDialog({
  onClose,
  operatorFundedPayer,
  organizationId,
  provider,
}: Readonly<{
  onClose: () => void;
  operatorFundedPayer: string;
  organizationId: string;
  provider: ModelCredentialProvider;
}>) {
  const queryClient = useQueryClient();
  const name = PROVIDER_LABELS[provider];
  return (
    <ActionDialog
      confirmLabel="Remove key"
      description={`Model calls to ${name} are then paid by ${operatorFundedPayer}, within the organization's allowance.`}
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateModelKeys(queryClient, organizationId)}
      open
      run={(idempotencyKey) =>
        removeModelKeyFn({ data: { idempotencyKey, provider, scope: { organizationId } } })
      }
      successMessage={`${name} key removed`}
      title={`Remove the ${name} key`}
    />
  );
}
