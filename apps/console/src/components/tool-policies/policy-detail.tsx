import {
  Archive02Icon,
  Copy01Icon,
  PencilEdit02Icon,
  TestTube01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { archiveToolPolicyFn } from "../../data/tool-policy-mutations.ts";
import {
  invalidateToolPolicies,
  policyPinsQuery,
  policyQuery,
} from "../../data/tool-policy-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  pinnedBy,
  policyActions,
  policyPinning,
  type ToolPolicyView,
} from "../../tool-policies/policy-state.ts";
import { describeRule, fromPolicy, ruleFindings } from "../../tool-policies/rules-editor.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { PinnedByTable, PinningNotice } from "./pinned-by.tsx";
import { StatusBadge } from "@/components/status-badge";

function RulesTable({ policy }: Readonly<{ policy: ToolPolicyView }>) {
  const draft = fromPolicy(policy);
  const findings = ruleFindings(draft);
  if (draft.rules.length === 0) {
    return <Text>No rules. Every tool gets the default below.</Text>;
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Rule</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {draft.rules.map((rule, index) => {
          const finding = findings.get(rule.key);
          return (
            <TableRow key={rule.key}>
              <TableCell className="tabular-nums">{index + 1}</TableCell>
              <TableCell className="whitespace-normal">
                {describeRule(rule)}
                {finding ? (
                  <Badge className="ml-2" color="amber">
                    {finding.kind === "never_matches"
                      ? "Never matches"
                      : `Unreachable after rule ${finding.by + 1}`}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {rule.reason || "Platform default"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PinnedBy({ policyId, scope }: Readonly<{ policyId: string; scope: EnvironmentScope }>) {
  const { data: pins } = useSuspenseQuery(policyPinsQuery(scope));
  const pinning = pinnedBy(policyId, pins.deployments);
  return (
    <div className="flex flex-col gap-3">
      {pinning.length === 0 ? (
        <Text>No live deployment pins this policy.</Text>
      ) : (
        <PinnedByTable pinning={pinning} scope={scope} />
      )}
      {pins.complete ? null : (
        <Text>
          The environment has more deployments than the console reads; this list may be partial.
        </Text>
      )}
    </div>
  );
}

function ArchiveAction({
  pinsVisible,
  policy,
  scope,
}: Readonly<{ pinsVisible: boolean; policy: ToolPolicyView; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const expectedVersionFor = useKeyedSnapshot<number>();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: pins } = useQuery({ ...policyPinsQuery(scope), enabled: pinsVisible });
  const pinning = policyPinning(policy.id, pins);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Icon icon={Archive02Icon} />
        Archive
      </Button>
      <ActionDialog<ToolPolicyView>
        confirmLabel="Archive policy"
        confirmation={typedConfirmation(environment.type, {
          destructive: pinning.atRisk,
          phrase: policy.name,
        })}
        description="An archived policy cannot be restored. Deployments keep their pins, and the runtime denies every tool pinned to it with “Runtime tool policy is not active.”"
        destructive
        onClose={() => setOpen(false)}
        onSuccess={() => void invalidateToolPolicies(queryClient, scope)}
        open={open}
        run={(idempotencyKey, resend) =>
          refreshOnConflict(
            archiveToolPolicyFn({
              data: {
                expectedVersion: expectedVersionFor(idempotencyKey, resend, policy.version),
                idempotencyKey,
                policyId: policy.id,
                scope,
              },
            }),
            () => invalidateToolPolicies(queryClient, scope),
          )
        }
        size="2xl"
        successMessage="Tool policy archived"
        title={`Archive ${policy.name}`}
      >
        <PinningNotice pinning={pinning} scope={scope}>
          These live deployments pin it and will be denied those tools:
        </PinningNotice>
      </ActionDialog>
    </>
  );
}

export function PolicyDetail({
  policyId,
  scope,
}: Readonly<{ policyId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: policy } = useSuspenseQuery(policyQuery(scope, policyId));
  const { access } = shell;
  const actions = policyActions(policy);
  const basePath = `${environmentPath(scope)}/tool-policies`;
  const { defaultAction, defaultReason } = policy.policy;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{policy.name}</Heading>
        <StatusBadge status={policy.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {access.evaluateToolPolicy && policy.status === "active" ? (
            <Button href={`${basePath}/simulate?policy=${policy.id}`} variant="outline">
              <Icon icon={TestTube01Icon} />
              Simulate
            </Button>
          ) : null}
          {actions.includes("duplicate") && access.createToolPolicy ? (
            <Button href={`${basePath}/new?copyOf=${policy.id}`} variant="outline">
              <Icon icon={Copy01Icon} />
              Duplicate
            </Button>
          ) : null}
          {actions.includes("edit") && access.updateToolPolicy ? (
            <Button href={`${basePath}/${policy.id}/edit`} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Edit
            </Button>
          ) : null}
          {actions.includes("archive") && access.archiveToolPolicy ? (
            <ArchiveAction
              pinsVisible={access.listAgentDeployments}
              policy={policy}
              scope={scope}
            />
          ) : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={policy.id} />
        </DescriptionDetails>
        {policy.description ? (
          <>
            <DescriptionTerm>Description</DescriptionTerm>
            <DescriptionDetails>{policy.description}</DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Version</DescriptionTerm>
        <DescriptionDetails>{policy.version}</DescriptionDetails>
        <DescriptionTerm>When no rule matches</DescriptionTerm>
        <DescriptionDetails>
          {defaultAction ? (
            <>
              <StatusBadge status={defaultAction} />
              {defaultReason ? <span className="ml-2">{defaultReason}</span> : null}
            </>
          ) : (
            "Each tool's own default"
          )}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={policy.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={policy.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Rules</Subheading>
        <Text>The runtime checks rules in order; the first match decides.</Text>
        <RulesTable policy={policy} />
      </section>
      {access.listAgentDeployments ? (
        <section className="flex flex-col gap-4">
          <Subheading>Pinned by</Subheading>
          <SectionBoundary resetKey={policy.id}>
            <PinnedBy policyId={policy.id} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
    </div>
  );
}
