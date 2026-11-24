import { PencilEdit02Icon, PlusSignIcon, PolicyIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { createPolicyFn, updatePolicyFn } from "../../data/memory-mutations.ts";
import { invalidateMemory, policiesQuery } from "../../data/memory-queries.ts";
import { policyReach, retentionWarning, strategyLabel } from "../../memory/copy.ts";
import {
  RETRIEVAL_STRATEGIES,
  SENSITIVITY_MODES,
  policyDraft,
  policyRequest,
  type MemoryPolicy,
  type PolicyDraft,
  type PolicyRetrieval,
} from "../../memory/model.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  Legend,
  RadioField,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
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
import { DocsLink } from "../docs-link.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem } from "../section-boundary.tsx";

const RETRIEVAL_OPTIONS = [
  "default",
  ...RETRIEVAL_STRATEGIES,
] as const satisfies readonly PolicyRetrieval[];

const RETRIEVAL_LABELS: Readonly<Record<PolicyRetrieval, string>> = {
  custom: "Custom: set per purpose, with a partial rollout, or with a shadow strategy",
  default: `Platform default (${strategyLabel("dense-v1")})`,
  "dense-v1": strategyLabel("dense-v1"),
  "hybrid-rerank-v1": `${strategyLabel("hybrid-rerank-v1")} (adds a model rerank call to each search)`,
  "hybrid-rrf-v1": strategyLabel("hybrid-rrf-v1"),
};

const CREATE_SCOPES = [
  "environment",
  "organization",
] as const satisfies readonly PolicyDraft["scope"][];

type CreateScope = (typeof CREATE_SCOPES)[number];

type PolicyDialogState =
  | { readonly kind: "create"; readonly scopes: readonly [CreateScope, ...CreateScope[]] }
  | { readonly kind: "edit"; readonly policy: MemoryPolicy };

function RetrievalSettings({ policy }: Readonly<{ policy: MemoryPolicy }>) {
  return (
    <details>
      <summary className="cursor-pointer">Settings</summary>
      <CodeBlock
        className="mt-2"
        code={JSON.stringify(policy.retrievalSettings, null, 2)}
        defaultWrap
        label="Retrieval settings"
        language="json"
      />
    </details>
  );
}

export function PolicyList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: policies } = useSuspenseQuery(policiesQuery(scope));
  const [dialog, setDialog] = useState<PolicyDialogState>();
  const { access } = shell;
  const freeScopes = (listed: readonly MemoryPolicy[]) =>
    CREATE_SCOPES.filter((option) => !listed.some((policy) => policy.scope === option));
  const open = (choose: (latest: readonly MemoryPolicy[]) => PolicyDialogState | undefined) =>
    void queryClient.fetchQuery({ ...policiesQuery(scope), staleTime: 0 }).then(
      (latest) => setDialog(choose(latest)),
      (error: Error) => {
        const problem = describeProblem(error, "The policies could not be reloaded");
        toast.error(problem.title, problem.description ? { description: problem.description } : {});
      },
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Text className="max-w-3xl">
          A policy sets active recall, sensitivity, retention, and the retrieval strategy. Each
          agent gets the most specific policy: its workspace's, then this environment's, then the
          organization's. Organization policies are stored per environment, so one here applies only
          here.
        </Text>
        {access.createMemoryPolicy && freeScopes(policies).length > 0 ? (
          <Button
            className="ml-auto"
            onClick={() =>
              open((latest) => {
                const [first, ...others] = freeScopes(latest);
                return first === undefined
                  ? undefined
                  : { kind: "create", scopes: [first, ...others] };
              })
            }
            variant="outline"
          >
            <Icon icon={PlusSignIcon} />
            Create policy
          </Button>
        ) : null}
      </div>
      {policies.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/memory" icon={PolicyIcon} title="No memory policies" />
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Scope</TableHead>
              <TableHead>Active recall</TableHead>
              <TableHead>Sensitivity</TableHead>
              <TableHead className="text-right">Retention</TableHead>
              <TableHead>Retrieval</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.id}>
                <TableCell>
                  {policy.scope}
                  {policy.workspaceId ? (
                    <div>
                      <PublicId value={policy.workspaceId} />
                    </div>
                  ) : null}
                </TableCell>
                <TableCell>
                  {policy.activeRecallEnabled
                    ? `On for ${formatExact(policy.activeRecallRolloutPercent)}% of runs`
                    : "Off"}
                </TableCell>
                <TableCell>{policy.sensitivityMode}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {policy.retentionDays === undefined
                    ? "Not set"
                    : `${formatExact(policy.retentionDays)} days`}
                </TableCell>
                <TableCell>
                  {policy.retrieval === "custom" ? "Custom" : RETRIEVAL_LABELS[policy.retrieval]}
                  {policy.retrieval === "custom" ? <RetrievalSettings policy={policy} /> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={policy.updatedAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={policy.id} />
                </TableCell>
                <TableCell>
                  {access.upsertMemoryPolicy ? (
                    <Button
                      onClick={() =>
                        open((latest) => {
                          const fresh = latest.find((candidate) => candidate.id === policy.id);
                          return fresh && { kind: "edit", policy: fresh };
                        })
                      }
                      variant="outline"
                    >
                      <Icon icon={PencilEdit02Icon} />
                      Edit
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dialog ? (
        <PolicyDialog dialog={dialog} onClose={() => setDialog(undefined)} scope={scope} />
      ) : null}
    </div>
  );
}

function PolicyDialog({
  dialog,
  onClose,
  scope,
}: Readonly<{ dialog: PolicyDialogState; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: policies } = useSuspenseQuery(policiesQuery(scope));
  const policy = dialog.kind === "edit" ? dialog.policy : undefined;
  const createScopes = dialog.kind === "create" ? dialog.scopes : [];
  const [draft, setDraft] = useState(() =>
    dialog.kind === "create"
      ? { ...policyDraft(undefined), scope: dialog.scopes[0] }
      : policyDraft(dialog.policy),
  );
  const parsed = policyRequest(policy, draft);
  const refresh = () => invalidateMemory(queryClient, scope);
  const reach = policyReach(policy ?? { scope: draft.scope });
  const warning = parsed.ok
    ? retentionWarning({
        current: policy,
        next: parsed.request.retentionDays,
        policies,
        scope: policy?.scope ?? draft.scope,
      })
    : undefined;
  const retrievalOptions =
    policy?.retrieval === "custom" ? (["custom"] as const) : RETRIEVAL_OPTIONS;

  return (
    <ActionDialog<MemoryPolicy>
      confirmLabel={policy ? "Save policy" : "Create policy"}
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: `${policy?.scope ?? draft.scope} policy`,
      })}
      description={`${reach} Saving changes recall, sensitivity, retention, and retrieval wherever it applies.`}
      invalid={!parsed.ok}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      run={(idempotencyKey) => {
        if (!parsed.ok) throw new TypeError(parsed.problem);
        return refreshOnConflict(
          policy
            ? updatePolicyFn({
                data: { body: parsed.request, idempotencyKey, policyId: policy.id, scope },
              })
            : createPolicyFn({ data: { body: parsed.request, idempotencyKey, scope } }),
          refresh,
        );
      }}
      size="xl"
      successMessage={policy ? "Memory policy saved" : "Memory policy created"}
      title={policy ? `Edit the ${policy.scope} memory policy` : "Create a memory policy"}
    >
      {createScopes.length > 1 ? (
        <Fieldset>
          <Legend>Scope</Legend>
          <RadioGroup
            onValueChange={(value: string) => {
              const known = oneOf(CREATE_SCOPES, value);
              if (known) setDraft({ ...draft, scope: known });
            }}
            value={draft.scope}
          >
            {createScopes.map((option) => (
              <RadioField key={option}>
                <RadioGroupItem value={option} />
                <Label>{option === "environment" ? "Environment" : "Organization"}</Label>
              </RadioField>
            ))}
          </RadioGroup>
        </Fieldset>
      ) : null}
      <CheckboxField>
        <Checkbox
          checked={draft.activeRecallEnabled}
          onCheckedChange={(activeRecallEnabled) => setDraft({ ...draft, activeRecallEnabled })}
        />
        <Label>Active recall</Label>
        <Description>
          Before the model answers, the runtime recalls up to 32 memories for agents whose manifest
          turns memory on.
        </Description>
      </CheckboxField>
      <Field>
        <Label>Active recall rollout, percent of runs</Label>
        <Input
          autoComplete="off"
          inputMode="numeric"
          onChange={(event) =>
            setDraft({ ...draft, activeRecallRolloutPercent: event.target.value })
          }
          value={draft.activeRecallRolloutPercent}
        />
      </Field>
      <Field>
        <Label>Sensitivity mode</Label>
        <NativeSelect
          onChange={(event) => {
            const sensitivityMode = oneOf(SENSITIVITY_MODES, event.target.value);
            if (sensitivityMode) setDraft({ ...draft, sensitivityMode });
          }}
          value={draft.sensitivityMode}
        >
          {SENSITIVITY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Retention in days</Label>
        <Description>
          1 to 3650. Replaces the retention of every space the policy reaches, and a new policy left
          blank uses each space's own. It applies to existing memories too: each expires this many
          days after it was created, and the platform permanently deletes memories past it.
        </Description>
        <Input
          autoComplete="off"
          inputMode="numeric"
          onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value })}
          value={draft.retentionDays}
        />
      </Field>
      {warning ? (
        <Callout variant="destructive">
          <CalloutTitle>Saving can permanently delete memories</CalloutTitle>
          <CalloutDescription>{warning}</CalloutDescription>
        </Callout>
      ) : null}
      <Field>
        <Label>Retrieval strategy</Label>
        {policy?.retrieval === "custom" ? (
          <Description>
            This policy sets retrieval per purpose, with a partial rollout, or with a shadow
            strategy, so the console keeps it as it is.{" "}
            <DocsLink path="/docs/api/reference/memory/upsert-memory-policy/">
              Change it through the API
            </DocsLink>
            .
          </Description>
        ) : null}
        <NativeSelect
          disabled={policy?.retrieval === "custom"}
          onChange={(event) => {
            const retrieval = oneOf(RETRIEVAL_OPTIONS, event.target.value);
            if (retrieval) setDraft({ ...draft, retrieval });
          }}
          value={draft.retrieval}
        >
          {retrievalOptions.map((option) => (
            <option key={option} value={option}>
              {RETRIEVAL_LABELS[option]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {policy?.retrieval === "custom" ? <RetrievalSettings policy={policy} /> : null}
      {parsed.ok ? null : <ErrorMessage>{parsed.problem}</ErrorMessage>}
    </ActionDialog>
  );
}
