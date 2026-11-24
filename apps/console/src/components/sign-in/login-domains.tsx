import type { LoginDomainResponse } from "@deployments-ai/api-contract";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { OperationAccess } from "../../access.ts";
import {
  addLoginDomainFn,
  removeLoginDomainFn,
  verifyLoginDomainFn,
} from "../../data/sign-in-mutations.ts";
import { invalidateSignIn, loginDomainsQuery } from "../../data/sign-in-queries.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
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
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { CopyField } from "../copy-field.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

type DomainDialog =
  | { readonly kind: "add" }
  | { readonly kind: "remove" | "verify"; readonly domain: LoginDomainResponse };

export function LoginDomains({
  access,
  organizationId,
}: Readonly<{ access: OperationAccess; organizationId: string }>) {
  const { data: domains } = useSuspenseQuery(loginDomainsQuery(organizationId));
  const [dialog, setDialog] = useState<DomainDialog>();
  const [published, setPublished] = useState<LoginDomainResponse>();
  const close = () => setDialog(undefined);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Login domains</Subheading>
        {access.addLoginDomain ? (
          <Button className="ml-auto" onClick={() => setDialog({ kind: "add" })} variant="outline">
            <Icon icon={PlusSignIcon} />
            Add domain
          </Button>
        ) : null}
      </div>
      <Text>
        Members whose email is on a verified domain sign in through the identity provider.
      </Text>
      {domains.length === 0 ? (
        <Text>No login domains.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map((domain) => (
              <TableRow key={domain.id}>
                <TableCell className="font-mono">{domain.domain}</TableCell>
                <TableCell>
                  <StatusBadge status={domain.state.kind} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={domain.createdAt} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    {domain.state.kind === "pending" ? (
                      <Button onClick={() => setPublished(domain)} variant="ghost">
                        TXT record
                      </Button>
                    ) : null}
                    {access.verifyLoginDomain && domain.state.kind === "pending" ? (
                      <Button onClick={() => setDialog({ domain, kind: "verify" })} variant="ghost">
                        Verify
                      </Button>
                    ) : null}
                    {access.removeLoginDomain ? (
                      <Button onClick={() => setDialog({ domain, kind: "remove" })} variant="ghost">
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialog?.kind === "add" ? (
        <AddDomainDialog onAdded={setPublished} onClose={close} organizationId={organizationId} />
      ) : null}
      {published ? (
        <PublishDialog domain={published} onClose={() => setPublished(undefined)} />
      ) : null}
      {dialog?.kind === "verify" || dialog?.kind === "remove" ? (
        <DomainActionDialog
          action={dialog.kind}
          domain={dialog.domain}
          onClose={close}
          organizationId={organizationId}
        />
      ) : null}
    </section>
  );
}

function AddDomainDialog({
  onAdded,
  onClose,
  organizationId,
}: Readonly<{
  onAdded: (domain: LoginDomainResponse) => void;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const domain = value.trim().toLowerCase();
  const valid = DOMAIN_NAME.test(domain);
  return (
    <ActionDialog
      confirmLabel="Add domain"
      description="You publish a TXT record next, then verify the domain."
      invalid={!valid}
      onClose={onClose}
      onSuccess={(added: LoginDomainResponse) => {
        void invalidateSignIn(queryClient, organizationId);
        onAdded(added);
      }}
      open
      run={(idempotencyKey) =>
        addLoginDomainFn({ data: { body: { domain }, idempotencyKey, scope: { organizationId } } })
      }
      successMessage="Domain added"
      title="Add a login domain"
    >
      <Field>
        <Label>Domain</Label>
        <Description>The part after the @ in members' work email, such as example.com.</Description>
        <Input
          aria-invalid={value !== "" && !valid}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      </Field>
    </ActionDialog>
  );
}

function PublishDialog({
  domain,
  onClose,
}: Readonly<{ domain: LoginDomainResponse; onClose: () => void }>) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent showCloseButton={false} size="xl">
        <DialogHeader>
          <DialogTitle>Publish this TXT record for {domain.domain}</DialogTitle>
          <DialogDescription>
            Add the record at your DNS provider, wait for it to propagate, then verify the domain.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          <CopyField label="Record name" value={domain.dnsRecord.name} />
          <CopyField label="Record value" value={domain.dnsRecord.value} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DomainActionDialog({
  action,
  domain,
  onClose,
  organizationId,
}: Readonly<{
  action: "remove" | "verify";
  domain: LoginDomainResponse;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const scope = { organizationId };
  const refresh = () => invalidateSignIn(queryClient, organizationId);
  return action === "verify" ? (
    <ActionDialog
      confirmLabel="Verify"
      description={`Checks for a TXT record named ${domain.dnsRecord.name}.`}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          verifyLoginDomainFn({ data: { id: domain.id, idempotencyKey, scope } }),
          refresh,
        )
      }
      successMessage="Domain verified"
      title={`Verify ${domain.domain}`}
    />
  ) : (
    <ActionDialog
      confirmLabel="Remove domain"
      confirmation={domain.domain}
      description="Members with this email domain can no longer sign in through the identity provider."
      destructive
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          removeLoginDomainFn({ data: { id: domain.id, idempotencyKey, scope } }),
          refresh,
        )
      }
      successMessage="Domain removed"
      title={`Remove ${domain.domain}?`}
    />
  );
}
