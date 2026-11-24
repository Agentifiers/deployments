import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  formatBudgetUsd,
  invalid,
  parseUsdAmount,
  usdInputValue,
  type Parsed,
} from "../../budgets/budget-amount.ts";
import {
  admissionImpact,
  BUDGET_ALERT_DELIVERY,
  BUDGET_CREATE_LEVELS,
  BUDGET_PERIOD_KINDS,
  budgetChanges,
  budgetConfirmation,
  DEFAULT_THRESHOLDS,
  parseThresholds,
  PERIOD_COPY,
  readBudgetDraft,
  type AdmissionEffect,
  type AdmissionImpact,
  type Budget,
  type BudgetEdit,
  type BudgetCreateLevel,
  type BudgetPeriodKind,
  type BudgetScopeLevel,
  type BudgetStatusChange,
  type BudgetTarget,
  type CreateBudgetBody,
} from "../../budgets/budget-state.ts";
import {
  archiveBudgetFn,
  createBudgetFn,
  setBudgetStatusFn,
  updateBudgetFn,
} from "../../data/budget-mutations.ts";
import {
  budgetPeriodsQuery,
  invalidateBudgets,
  targetPeriodQuery,
} from "../../data/budget-queries.ts";
import { workspacesQuery } from "../../data/connection-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { WorkspaceView } from "../../connections/connection-state.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
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
import { Code } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";

const LEVEL_COPY: Readonly<
  Record<BudgetCreateLevel, { readonly description: string; readonly label: string }>
> = {
  environment: { description: "Runs in one environment.", label: "Environment" },
  organization: {
    description: "Every run in every project and environment of the organization.",
    label: "Organization",
  },
  project: { description: "Runs in every environment of one project.", label: "Project" },
  workspace: { description: "Runs that name one workspace of an environment.", label: "Workspace" },
};

interface TargetChoice {
  readonly environmentId: string;
  readonly level: BudgetCreateLevel;
  readonly projectId: string;
  readonly workspaceId: string;
}

type Projects = OrganizationShell["projects"];
type Workspaces = readonly WorkspaceView[];

function chosenEnvironment(choice: TargetChoice, projects: Projects) {
  return projects
    .flatMap(({ environments }) => environments)
    .find((candidate) => candidate.id === choice.environmentId);
}

/** Budgets need an active target, so only active projects and environments are offered. */
function activeProjects(projects: OrganizationShell["projects"]) {
  return projects
    .filter(({ project }) => project.status === "active")
    .map((entry) => ({
      ...entry,
      environments: entry.environments.filter((environment) => environment.status === "active"),
    }));
}

function chosenTarget(
  choice: TargetChoice,
  projects: Projects,
  workspaces: Workspaces,
): BudgetTarget | undefined {
  switch (choice.level) {
    case "organization":
      return { scope: "organization" };
    case "project":
      return projects.some(({ project }) => project.id === choice.projectId)
        ? { projectId: choice.projectId, scope: "project" }
        : undefined;
    case "environment": {
      const environment = chosenEnvironment(choice, projects);
      return environment
        ? { environmentId: environment.id, projectId: environment.projectId, scope: "environment" }
        : undefined;
    }
    case "workspace": {
      const environment = chosenEnvironment(choice, projects);
      const workspace = workspaces.find((candidate) => candidate.id === choice.workspaceId);
      return environment && workspace
        ? {
            environmentId: environment.id,
            projectId: environment.projectId,
            scope: "workspace",
            workspaceId: workspace.id,
          }
        : undefined;
    }
  }
}

function FieldProblem({ parsed, text }: Readonly<{ parsed: Parsed<unknown>; text: string }>) {
  return text.trim() === "" || parsed.ok ? null : <ErrorMessage>{parsed.message}</ErrorMessage>;
}

/** Name, then `children` (the create dialog's target and period), then amount and thresholds. */
function BudgetFields({
  children,
  edit,
  level,
  onChange,
}: Readonly<{
  children?: ReactNode;
  edit: BudgetEdit;
  level: BudgetScopeLevel;
  onChange: (edit: BudgetEdit) => void;
}>) {
  const amount = parseUsdAmount(edit.amount);
  const thresholds = parseThresholds(edit.thresholds);
  return (
    <>
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          onChange={(event) => onChange({ ...edit, name: event.target.value })}
          value={edit.name}
        />
      </Field>
      {children}
      <Field>
        <Label>Amount (USD)</Label>
        <Description>New runs are refused once the period&apos;s spend reaches it.</Description>
        <Input
          autoComplete="off"
          inputMode="decimal"
          aria-invalid={edit.amount.trim() !== "" && !amount.ok}
          onChange={(event) => onChange({ ...edit, amount: event.target.value })}
          placeholder="250.00"
          value={edit.amount}
        />
        <FieldProblem parsed={amount} text={edit.amount} />
        {amount.ok ? <Description>Reads as {formatBudgetUsd(amount.value)}</Description> : null}
      </Field>
      <Field>
        <Label>Alert thresholds (%)</Label>
        <Description>
          Percentages of the amount, separated by commas. Crossing each one emits a{" "}
          <Code>budget.threshold-crossed</Code> event and lists the budget under alerts on the
          Budgets page. {BUDGET_ALERT_DELIVERY[level]}
        </Description>
        <Input
          autoComplete="off"
          aria-invalid={edit.thresholds.trim() !== "" && !thresholds.ok}
          onChange={(event) => onChange({ ...edit, thresholds: event.target.value })}
          value={edit.thresholds}
        />
        <FieldProblem parsed={thresholds} text={edit.thresholds} />
      </Field>
    </>
  );
}

function TargetFields({
  choice,
  levels,
  onChange,
  projects,
  workspaces,
}: Readonly<{
  choice: TargetChoice;
  levels: readonly BudgetCreateLevel[];
  onChange: (choice: TargetChoice) => void;
  projects: Projects;
  workspaces: Workspaces | undefined;
}>) {
  return (
    <>
      <Fieldset>
        <Legend>Applies to</Legend>
        <RadioGroup
          className="mt-3"
          onValueChange={(level: string) => {
            const known = oneOf(levels, level);
            if (known) onChange({ ...choice, level: known });
          }}
          value={choice.level}
        >
          {levels.map((level) => (
            <RadioField key={level}>
              <RadioGroupItem value={level} />
              <Label>{LEVEL_COPY[level].label}</Label>
              <Description>{LEVEL_COPY[level].description}</Description>
            </RadioField>
          ))}
        </RadioGroup>
      </Fieldset>
      {choice.level === "project" ? (
        <Field>
          <Label>Project</Label>
          <NativeSelect
            onChange={(event) => onChange({ ...choice, projectId: event.target.value })}
            value={choice.projectId}
          >
            {projects.map(({ project }) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {choice.level === "environment" || choice.level === "workspace" ? (
        <Field>
          <Label>Environment</Label>
          <NativeSelect
            onChange={(event) =>
              onChange({ ...choice, environmentId: event.target.value, workspaceId: "" })
            }
            value={choice.environmentId}
          >
            {projects.flatMap(({ environments, project }) =>
              environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {project.name} / {environment.name} ({environment.type})
                </option>
              )),
            )}
          </NativeSelect>
        </Field>
      ) : null}
      {choice.level === "workspace" ? (
        <Field>
          <Label>Workspace</Label>
          {workspaces === undefined ? (
            <Description>Loading workspaces…</Description>
          ) : workspaces.length === 0 ? (
            <Description>This environment has no active workspace.</Description>
          ) : (
            <NativeSelect
              onChange={(event) => onChange({ ...choice, workspaceId: event.target.value })}
              value={choice.workspaceId}
            >
              <option disabled value="">
                Choose a workspace
              </option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
    </>
  );
}

const EMPTY_EDIT: BudgetEdit = {
  amount: "",
  name: "",
  thresholds: DEFAULT_THRESHOLDS.join(", "),
};

export function CreateBudgetDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const projects = activeProjects(shell.projects);
  const environments = projects.flatMap((entry) => entry.environments);
  const initialChoice: TargetChoice = {
    environmentId:
      (environments.find(({ id }) => id === scope.environmentId) ?? environments[0])?.id ?? "",
    level: "environment",
    projectId:
      (projects.find(({ project }) => project.id === scope.projectId) ?? projects[0])?.project.id ??
      "",
    workspaceId: "",
  };
  const levels = BUDGET_CREATE_LEVELS.filter(
    (level) => level !== "workspace" || shell.access.listWorkspaces,
  );
  const [edit, setEdit] = useState(EMPTY_EDIT);
  const [choice, setChoice] = useState(initialChoice);
  const [period, setPeriod] = useState<BudgetPeriodKind>("monthly");
  useEffect(() => {
    if (!open) return;
    setEdit(EMPTY_EDIT);
    setChoice(initialChoice);
    setPeriod("monthly");
  }, [open]);
  const workspaceEnvironment = chosenEnvironment(choice, projects);
  const workspaces = useQuery({
    ...workspacesQuery({
      environmentId: workspaceEnvironment?.id ?? "",
      organizationId: scope.organizationId,
      projectId: workspaceEnvironment?.projectId ?? "",
    }),
    enabled: open && choice.level === "workspace" && workspaceEnvironment !== undefined,
    select: (all) => all.filter((workspace) => workspace.status === "active"),
  });
  const target = chosenTarget(choice, projects, workspaces.data ?? []);
  const request: Parsed<CreateBudgetBody> = target
    ? readBudgetDraft({ ...edit, period, target })
    : invalid("Choose what the budget applies to");
  const twin = useQuery({
    ...targetPeriodQuery(scope, target ?? { scope: "organization" }, period),
    enabled: open && target !== undefined,
  });
  const impact =
    target && request.ok && !twin.isPending
      ? admissionImpact(
          { ...target, amountUsdMicros: request.value.amountUsdMicros, status: "active" },
          twin.data ?? undefined,
          shell.projects,
        )
      : undefined;

  return (
    <ActionDialog
      confirmLabel="Create budget"
      confirmation={
        target ? budgetConfirmation(target, shell.projects, { effect: impact?.effect }) : undefined
      }
      description="Period and target cannot change later. Spend counts from the start of the period, so a new budget already includes this period's spend."
      invalid={!request.ok || twin.isPending}
      onClose={onClose}
      onSuccess={(budget: Budget) => {
        void invalidateBudgets(queryClient, scope.organizationId);
        void navigate({
          params: {
            budgetId: budget.id,
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/budgets/$budgetId",
        });
      }}
      open={open}
      run={(idempotencyKey) => {
        if (!request.ok) throw new TypeError(request.message);
        return createBudgetFn({
          data: {
            body: request.value,
            idempotencyKey,
            scope: { organizationId: scope.organizationId },
          },
        });
      }}
      size="xl"
      successMessage="Budget created"
      title="Create budget"
    >
      <BudgetFields edit={edit} level={choice.level} onChange={setEdit}>
        <TargetFields
          choice={choice}
          levels={levels}
          onChange={setChoice}
          projects={projects}
          workspaces={workspaces.data}
        />
        <Field>
          <Label>Period</Label>
          <Description>Periods follow the UTC calendar.</Description>
          <NativeSelect
            onChange={(event) => {
              const known = oneOf(BUDGET_PERIOD_KINDS, event.target.value);
              if (known) setPeriod(known);
            }}
            value={period}
          >
            {BUDGET_PERIOD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {PERIOD_COPY[kind].label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </BudgetFields>
      <ImpactCallout impact={impact} />
    </ActionDialog>
  );
}

const IMPACT_COPY: Readonly<
  Record<
    Exclude<AdmissionEffect, "admits">,
    {
      readonly lead: string;
      readonly title: string;
      readonly variant: "default" | "destructive";
    }
  >
> = {
  "keeps-refusing": {
    lead: "This period's spend already reaches the amount, so new runs stay refused in",
    title: "New runs stay refused",
    variant: "default",
  },
  "refuses-now": {
    lead: "This period's spend already reaches the amount, so new runs are refused at once in",
    title: "New runs will be refused",
    variant: "destructive",
  },
  "spend-unknown": {
    lead: "The console cannot see this target's spend for the period. If it already reaches the amount, new runs are refused at once in",
    title: "New runs may be refused at once",
    variant: "default",
  },
};

/** Says which environments a change refuses, or may refuse, new runs in. */
function ImpactCallout({ impact }: Readonly<{ impact: AdmissionImpact | undefined }>) {
  if (impact === undefined || impact.effect === "admits") return null;
  const copy = IMPACT_COPY[impact.effect];
  return (
    <Callout variant={copy.variant}>
      <CalloutTitle>{copy.title}</CalloutTitle>
      <CalloutDescription>
        {copy.lead} {impact.environments.join(", ") || "no active environment"}.
      </CalloutDescription>
    </Callout>
  );
}

function editOf(budget: Budget): BudgetEdit {
  return {
    amount: usdInputValue(budget.amountUsdMicros),
    name: budget.name,
    thresholds: budget.thresholds.join(", "),
  };
}

export function EditBudgetDialog({
  budget,
  onClose,
  open,
  scope,
}: Readonly<{ budget: Budget; onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [budgetAtOpen, setBudgetAtOpen] = useState(budget);
  const [edit, setEdit] = useState(() => editOf(budget));
  useEffect(() => {
    if (!open) return;
    setBudgetAtOpen(budget);
    setEdit(editOf(budget));
  }, [open]);
  const changes = budgetChanges(budgetAtOpen, edit);
  const refresh = () => invalidateBudgets(queryClient, scope.organizationId);
  const periods = useInfiniteQuery({ ...budgetPeriodsQuery(scope, budget.id), enabled: open });
  const impact = periods.isPending
    ? undefined
    : admissionImpact(
        {
          ...budgetAtOpen,
          amountUsdMicros:
            (changes.ok ? changes.value.amountUsdMicros : undefined) ??
            budgetAtOpen.amountUsdMicros,
        },
        periods.data?.pages[0]?.items[0],
        shell.projects,
        budgetAtOpen,
      );

  return (
    <ActionDialog
      confirmLabel="Save changes"
      confirmation={budgetConfirmation(budget, shell.projects, {
        budgetId: budget.id,
        effect: impact?.effect,
      })}
      description="Archive this budget and create a new one to change its period or target."
      invalid={!changes.ok || periods.isPending}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey) => {
        if (!changes.ok) throw new TypeError(changes.message);
        return refreshOnConflict(
          updateBudgetFn({
            data: {
              body: changes.value,
              budgetId: budget.id,
              expectedVersion: budgetAtOpen.version,
              idempotencyKey,
              scope: { organizationId: scope.organizationId },
            },
          }),
          refresh,
        );
      }}
      size="xl"
      successMessage="Budget updated"
      title={`Edit ${budget.name}`}
    >
      <BudgetFields edit={edit} level={budget.scope} onChange={setEdit} />
      <ImpactCallout impact={impact} />
    </ActionDialog>
  );
}

const STATUS_CHANGE_COPY: Readonly<
  Record<
    BudgetStatusChange,
    {
      readonly confirmLabel: string;
      readonly description: string;
      readonly destructive: boolean;
      readonly successMessage: string;
      readonly verb: string;
    }
  >
> = {
  archive: {
    confirmLabel: "Archive budget",
    description:
      "An archived budget stops governing runs and cannot be resumed or edited. Its period history stays readable.",
    destructive: true,
    successMessage: "Budget archived",
    verb: "Archive",
  },
  pause: {
    confirmLabel: "Pause budget",
    description:
      "A paused budget refuses no runs and sends no alerts. Spend keeps counting, so resuming it refuses runs at once if the period's spend has reached the amount.",
    destructive: false,
    successMessage: "Budget paused",
    verb: "Pause",
  },
  resume: {
    confirmLabel: "Resume budget",
    description:
      "The budget governs new runs again. If this period's spend has already reached the amount, new runs are refused at once.",
    destructive: false,
    successMessage: "Budget resumed",
    verb: "Resume",
  },
};

export function BudgetStatusDialog({
  budget,
  change,
  onClose,
  open,
  scope,
}: Readonly<{
  budget: Budget;
  change: BudgetStatusChange;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const copy = STATUS_CHANGE_COPY[change];
  const refresh = () => invalidateBudgets(queryClient, scope.organizationId);
  const resuming = change === "resume";
  const periods = useInfiniteQuery({
    ...budgetPeriodsQuery(scope, budget.id),
    enabled: open && resuming,
  });
  const impact =
    resuming && !periods.isPending
      ? admissionImpact(
          { ...budget, status: "active" },
          periods.data?.pages[0]?.items[0],
          shell.projects,
        )
      : undefined;
  return (
    <ActionDialog
      confirmLabel={copy.confirmLabel}
      confirmation={budgetConfirmation(budget, shell.projects, {
        budgetId: budget.id,
        destructive: copy.destructive,
        effect: impact?.effect,
      })}
      description={copy.description}
      destructive={copy.destructive}
      invalid={resuming && periods.isPending}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey) => {
        const data = {
          budgetId: budget.id,
          idempotencyKey,
          scope: { organizationId: scope.organizationId },
        };
        return refreshOnConflict(
          change === "archive"
            ? archiveBudgetFn({ data })
            : setBudgetStatusFn({ data: { ...data, change } }),
          refresh,
        );
      }}
      successMessage={copy.successMessage}
      title={`${copy.verb} ${budget.name}?`}
    >
      <ImpactCallout impact={impact} />
    </ActionDialog>
  );
}
