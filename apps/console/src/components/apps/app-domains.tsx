import type { AppDomainResponse, AppResponse } from "@deployments-ai/api-contract";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRef, useState, type RefObject } from "react";
import type { AppWrites } from "../../apps/app-state.ts";
import {
  DOMAIN_CHECK_SECONDS,
  domainCheckable,
  domainFollowed,
  domainPolls,
  domainProblemStep,
  domainProgress,
  domainRecheckSeconds,
} from "../../apps/domains.ts";
import { attachAppDomainFn, detachAppDomainFn } from "../../data/app-mutations.ts";
import { appDomainCheckQuery, appDomainsQuery, invalidateApps } from "../../data/app-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Description, Field, Fieldset, Label, Legend } from "@/components/ui/field";
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
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { CopyField } from "../copy-field.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { Refusal } from "./app-sections.tsx";
import { StatusBadge } from "@/components/status-badge";

const CHECK_INTERVAL_MS = DOMAIN_CHECK_SECONDS * 1000;

type DomainDialog =
  | { readonly kind: "attach" }
  | { readonly kind: "detach" | "records"; readonly domain: AppDomainResponse };

interface DomainsProps {
  readonly app: AppResponse;
  readonly scope: EnvironmentScope;
  readonly writes: AppWrites;
}

export function AppDomains({ app, scope, writes }: DomainsProps) {
  const canRefresh = writes.refreshAppDomain?.enabled === true;
  const { data: domains } = useSuspenseQuery({
    ...appDomainsQuery(scope, app.id),
    refetchInterval: (query) =>
      query.state.data?.some((domain) => domainFollowed(domain.state, canRefresh))
        ? CHECK_INTERVAL_MS
        : false,
  });
  const [dialog, setDialog] = useState<DomainDialog>();
  const heading = useRef<HTMLHeadingElement>(null);
  const [published, setPublished] = useState<AppDomainResponse>();
  const attach = writes.attachAppDomain;
  const close = () => setDialog(undefined);
  const open = (next: DomainDialog) =>
    next.kind === "records" ? setPublished(next.domain) : setDialog(next);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading ref={heading} tabIndex={-1}>
          Domains
        </Subheading>
        {attach ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <Button
              disabled={!attach.enabled}
              onClick={() => setDialog({ kind: "attach" })}
              variant="outline"
            >
              <Icon icon={PlusSignIcon} />
              Attach domain
            </Button>
            <Refusal reason={attach.enabled ? undefined : attach.reason} />
          </div>
        ) : null}
      </div>
      <Text>
        The app can also answer on hostnames your organization controls. Publish each domain's DNS
        records, then the platform proves ownership, issues a certificate, and connects the
        hostname.
      </Text>
      {domains.length === 0 ? (
        <Text>No custom domains. The app answers only on its own URL.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Hostname</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Attached</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map((domain) => (
              <DomainRow
                appId={app.id}
                canDetach={writes.detachAppDomain?.enabled === true}
                canRefresh={canRefresh}
                domain={domain}
                key={domain.id}
                onDialog={open}
                scope={scope}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {dialog?.kind === "attach" ? (
        <AttachDialog app={app} onAttached={setPublished} onClose={close} scope={scope} />
      ) : null}
      {published ? (
        <RecordsDialog domain={published} onClose={() => setPublished(undefined)} />
      ) : null}
      {dialog?.kind === "detach" ? (
        <DetachDialog
          app={app}
          domain={dialog.domain}
          onClose={close}
          scope={scope}
          successFocus={heading}
        />
      ) : null}
    </section>
  );
}

function DomainRow({
  appId,
  canDetach,
  canRefresh,
  domain,
  onDialog,
  scope,
}: Readonly<{
  appId: string;
  canDetach: boolean;
  canRefresh: boolean;
  domain: AppDomainResponse;
  onDialog: (dialog: DomainDialog) => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const [checkRequested, setCheckRequested] = useState(false);
  const polls = canRefresh && domainPolls(domain.state, checkRequested);
  const failedChecks = useRef(0);
  const check = useQuery({
    ...appDomainCheckQuery(queryClient, scope, appId, domain.id, failedChecks),
    enabled: polls,
    refetchInterval: (query) => {
      const seconds = domainRecheckSeconds({
        error: query.state.error,
        failedChecks: failedChecks.current,
      });
      return seconds === false ? false : seconds * 1000;
    },
    throwOnError: (error) => error instanceof UnauthenticatedError,
  });
  const recheck = polls
    ? domainRecheckSeconds({ error: check.error, failedChecks: failedChecks.current })
    : false;
  const problem = domain.state.kind === "unverified" ? null : domain.state.problem;
  const failure = check.error ? describeProblem(check.error, "The check failed") : undefined;
  return (
    <TableRow>
      <TableCell className="font-mono">{domain.hostname}</TableCell>
      <TableCell>
        <div className="flex max-w-md flex-col items-start gap-1 whitespace-normal">
          <StatusBadge status={domain.state.kind} />
          <Text>{domainProgress(domain.state)}</Text>
          {problem ? (
            <>
              <p className="text-sm/6 text-destructive">
                {problem.message} (<Timestamp value={problem.observedAt} />)
              </p>
              <Text>{domainProblemStep(problem.code)}</Text>
            </>
          ) : null}
          {failure ? (
            <p className="text-sm/6 text-destructive">
              {failure.title}
              {failure.description ? `. ${failure.description}` : null}
            </p>
          ) : null}
          {check.isFetching ? (
            <Text>Checking now…</Text>
          ) : recheck !== false ? (
            <Text>Checking every {recheck} seconds while this page is open.</Text>
          ) : domainFollowed(domain.state, canRefresh) ? (
            <Text>
              {check.isSuccess ? "Setup queued. It usually starts within seconds. " : null}
              Updating every {DOMAIN_CHECK_SECONDS} seconds while this page is open.
            </Text>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Timestamp value={domain.createdAt} />
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          <Button
            aria-label={`DNS records for ${domain.hostname}`}
            onClick={() => onDialog({ domain, kind: "records" })}
            variant="ghost"
          >
            DNS records
          </Button>
          {canRefresh && domainCheckable(domain.state) ? (
            <Button
              aria-label={`Check now for ${domain.hostname}`}
              disabled={check.isFetching}
              onClick={() => {
                setCheckRequested(true);
                void check.refetch();
              }}
              variant="ghost"
            >
              Check now
            </Button>
          ) : null}
          {canDetach ? (
            <Button
              aria-label={`Detach ${domain.hostname}`}
              onClick={() => onDialog({ domain, kind: "detach" })}
              variant="ghost"
            >
              Detach
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function AttachDialog({
  app,
  onAttached,
  onClose,
  scope,
}: Readonly<{
  app: AppResponse;
  onAttached: (domain: AppDomainResponse) => void;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [value, setValue] = useState("");
  const hostname = value.trim().toLowerCase();
  return (
    <ActionDialog
      confirmLabel="Attach domain"
      confirmation={typedConfirmation(environment.type, { phrase: app.slug })}
      description="You publish two DNS records next, then check the domain."
      invalid={!hostname.includes(".")}
      onClose={onClose}
      onSuccess={(domain: AppDomainResponse) => {
        void invalidateApps(queryClient, scope);
        onAttached(domain);
      }}
      open
      run={(idempotencyKey) =>
        attachAppDomainFn({ data: { appId: app.id, body: { hostname }, idempotencyKey, scope } })
      }
      successMessage={(domain: AppDomainResponse) => `${domain.hostname} attached`}
      title={`Attach a domain to ${app.name}`}
    >
      <Field>
        <Label>Hostname</Label>
        <Description>
          A hostname your organization controls, such as www.example.com or example.com.
        </Description>
        <Input
          autoComplete="off"
          name="hostname"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      </Field>
    </ActionDialog>
  );
}

function RecordsDialog({
  domain,
  onClose,
}: Readonly<{ domain: AppDomainResponse; onClose: () => void }>) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent showCloseButton={false} size="2xl">
        <DialogHeader>
          <DialogTitle>DNS records for {domain.hostname}</DialogTitle>
          <DialogDescription>
            Publish both records at your DNS provider. The TXT record proves your organization
            controls the hostname, and the CNAME record sends traffic for the hostname to the
            platform. Publish the TXT record before the first check, because resolvers remember a
            miss for a while.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-8">
          {domain.dnsRecords.map((record) => (
            <Fieldset key={`${record.type} ${record.name}`}>
              <Legend>{record.type} record</Legend>
              <div className="mt-4 flex flex-col gap-4">
                <CopyField label={`${record.type} name`} value={record.name} />
                <CopyField label={`${record.type} value`} value={record.value} />
                {record.note ? <Text>{record.note}</Text> : null}
              </div>
            </Fieldset>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetachDialog({
  app,
  domain,
  onClose,
  scope,
  successFocus,
}: Readonly<{
  app: AppResponse;
  domain: AppDomainResponse;
  onClose: () => void;
  scope: EnvironmentScope;
  successFocus: RefObject<HTMLElement | null>;
}>) {
  const queryClient = useQueryClient();
  const refresh = () => invalidateApps(queryClient, scope);
  return (
    <ActionDialog
      confirmLabel="Detach domain"
      confirmation={domain.hostname}
      description={`${domain.hostname} stops reaching ${app.name} and becomes free for another app or organization to verify. Remove its DNS records afterwards.`}
      destructive
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          detachAppDomainFn({
            data: { appId: app.id, domainId: domain.id, idempotencyKey, scope },
          }),
          refresh,
        )
      }
      successFocus={successFocus}
      successMessage={`${domain.hostname} detached`}
      title={`Detach ${domain.hostname}?`}
    />
  );
}
