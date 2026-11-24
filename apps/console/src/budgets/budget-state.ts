import type { CreateBudgetRequest, UpdateBudgetRequest } from "@deployments-ai/api-contract";
import type { EnvironmentScope } from "../scope.ts";
import type { OrganizationShell } from "../server/console-data.ts";
import type { RouteResponse } from "../server/platform-api.ts";
import { invalid, parseUsdAmount, percentUsed, type Parsed } from "./budget-amount.ts";

export type Budget = RouteResponse<"getBudget">;
export type BudgetPeriod = RouteResponse<"listBudgetPeriods">["items"][number];
export type BudgetStatus = Budget["status"];
export type BudgetScopeLevel = Budget["scope"];
export type BudgetPeriodKind = Budget["period"];
/** Request bodies as the browser builds them; the server decodes them against the contract. */
export type CreateBudgetBody = typeof CreateBudgetRequest.Encoded;
export type UpdateBudgetBody = typeof UpdateBudgetRequest.Encoded;

/** What a console-created budget governs; it is fixed at creation. */
export type BudgetTarget =
  | { readonly scope: "organization" }
  | { readonly projectId: string; readonly scope: "project" }
  | { readonly environmentId: string; readonly projectId: string; readonly scope: "environment" }
  | {
      readonly environmentId: string;
      readonly projectId: string;
      readonly scope: "workspace";
      readonly workspaceId: string;
    };

/** The target fields of a stored budget or a draft target. */
export interface TargetIds {
  readonly environmentId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly scope: BudgetScopeLevel;
  readonly workspaceId?: string | undefined;
}

/** Admission checks the narrowest budgets first: workspace, environment, project, organization. */
const ADMISSION_ORDER = {
  environment: 1,
  organization: 3,
  project: 2,
  workspace: 0,
} as const satisfies Readonly<Record<BudgetScopeLevel, number>>;

export const BUDGET_SCOPE_LEVELS = Object.keys(ADMISSION_ORDER) as readonly BudgetScopeLevel[];

/** The levels the create dialog offers. */
export const BUDGET_CREATE_LEVELS = [
  "organization",
  "project",
  "environment",
  "workspace",
] as const satisfies readonly BudgetTarget["scope"][];
export type BudgetCreateLevel = (typeof BUDGET_CREATE_LEVELS)[number];

export const BUDGET_PERIOD_KINDS = [
  "daily",
  "monthly",
  "quarterly",
  "yearly",
] as const satisfies readonly BudgetPeriodKind[];

/** How each period reads as a name and as "the current one" in a sentence. */
export const PERIOD_COPY: Readonly<
  Record<BudgetPeriodKind, { readonly current: string; readonly label: string }>
> = {
  daily: { current: "today", label: "Daily" },
  monthly: { current: "this month", label: "Monthly" },
  quarterly: { current: "this quarter", label: "Quarterly" },
  yearly: { current: "this year", label: "Yearly" },
};

/** Status machine. No transition carries an expected version. */
export type BudgetAction = "archive" | "edit" | "pause" | "resume";
export type BudgetStatusChange = Exclude<BudgetAction, "edit">;

export const BUDGET_ACTIONS: Readonly<Record<BudgetStatus, readonly BudgetAction[]>> = {
  active: ["edit", "pause", "archive"],
  archived: [],
  paused: ["edit", "resume", "archive"],
};

export const STATUS_AFTER = {
  archive: "archived",
  pause: "paused",
  resume: "active",
} as const satisfies Readonly<Record<BudgetStatusChange, BudgetStatus>>;

/** What the budget is doing to admission right now. */
export type BudgetHealth = "archived" | "over-limit-paused" | "refusing" | "unknown" | "within";

export interface BudgetRow {
  readonly budget: Budget;
  readonly current: BudgetPeriod | undefined;
  readonly governsHere: boolean;
  readonly health: BudgetHealth;
  readonly percent: number | undefined;
}

export interface BudgetRefusal {
  readonly budget: Budget;
  readonly current: BudgetPeriod;
  readonly percent: number;
}

export interface BudgetRefusalScan {
  /** False when the organization has more budgets than one scan reads. */
  readonly complete: boolean;
  readonly refusals: readonly BudgetRefusal[];
}

/** A live budget whose current period has crossed at least one alert threshold. */
export interface BudgetAlert {
  readonly budget: Budget;
  readonly current: BudgetPeriod;
  readonly percent: number;
  /** The highest threshold crossed this period. */
  readonly threshold: number;
}

export interface BudgetAlertScan {
  /** False when the organization has more budgets than one scan reads. */
  readonly complete: boolean;
  readonly alerts: readonly BudgetAlert[];
}

/**
 * Where a budget's `budget.threshold-crossed` event goes: an environment or workspace budget's
 * event reaches that environment's webhooks; an organization or project budget's event reaches
 * webhooks in every environment it covers, but only those that name the event type.
 */
export const BUDGET_ALERT_DELIVERY: Readonly<Record<BudgetScopeLevel, string>> = {
  environment: "Webhook subscriptions in the environment receive it.",
  organization:
    "Webhook subscriptions in any environment of the organization receive it when they list budget.threshold-crossed by name.",
  project:
    "Webhook subscriptions in the project's environments receive it when they list budget.threshold-crossed by name.",
  workspace: "Webhook subscriptions in the workspace's environment receive it.",
};

/** Live budgets whose current period has alerted, the furthest over first. */
export function budgetAlerts(
  entries: readonly Pick<BudgetRow, "budget" | "current">[],
): BudgetAlert[] {
  return entries
    .flatMap(({ budget, current }) => {
      const threshold = current?.current ? current.notifiedThresholds.at(-1) : undefined;
      return budget.status !== "archived" && current && threshold !== undefined
        ? [
            {
              budget,
              current,
              percent: percentUsed(current.spendUsdMicros, current.amountUsdMicros),
              threshold,
            },
          ]
        : [];
    })
    .toSorted(
      (left, right) =>
        right.percent - left.percent || left.budget.name.localeCompare(right.budget.name),
    );
}

export const BUDGET_VIEWS = ["applies", "all"] as const;
export type BudgetView = (typeof BUDGET_VIEWS)[number];

export interface BudgetSearch {
  readonly show?: "all";
}

export interface BudgetPage {
  readonly complete: boolean;
  readonly hidden: number;
  readonly nextOffset?: number;
  readonly rows: readonly BudgetRow[];
}

export interface BudgetDraft {
  readonly amount: string;
  readonly name: string;
  readonly period: BudgetPeriodKind;
  readonly target: BudgetTarget;
  readonly thresholds: string;
}

export interface BudgetEdit {
  readonly amount: string;
  readonly name: string;
  readonly thresholds: string;
}

const byAdmissionOrder = (left: Budget, right: Budget) =>
  ADMISSION_ORDER[left.scope] - ADMISSION_ORDER[right.scope] || left.name.localeCompare(right.name);

/** Whether the budget governs every run in the environment; a workspace's governs only its own. */
export function governs(budget: TargetIds, scope: EnvironmentScope): boolean {
  switch (budget.scope) {
    case "organization":
      return true;
    case "project":
      return budget.projectId === scope.projectId;
    case "environment":
      return budget.environmentId === scope.environmentId;
    case "workspace":
      return false;
  }
}

export function sameTarget(left: TargetIds, right: TargetIds): boolean {
  switch (left.scope) {
    case "organization":
      return right.scope === "organization";
    case "project":
      return right.scope === "project" && left.projectId === right.projectId;
    case "environment":
      return right.scope === "environment" && left.environmentId === right.environmentId;
    case "workspace":
      return right.scope === "workspace" && left.workspaceId === right.workspaceId;
  }
}

type ShellProjects = OrganizationShell["projects"];

/** Environments with runs the budget governs: every run there, or one workspace's runs. */
function governedEnvironments(target: TargetIds, projects: ShellProjects) {
  return projects.flatMap(({ environments, project }) =>
    environments.flatMap((environment) => {
      const scope = {
        environmentId: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
      };
      const reach =
        target.scope === "workspace" && target.environmentId === environment.id
          ? ("workspace" as const)
          : governs(target, scope)
            ? ("environment" as const)
            : undefined;
      return reach ? [{ environment, project, reach }] : [];
    }),
  );
}

/** A period's `exhausted` ignores status; only an active budget refuses runs. */
export function budgetHealth(
  budget: Pick<Budget, "status">,
  current: BudgetPeriod | undefined,
): BudgetHealth {
  if (budget.status === "archived") return "archived";
  if (!current?.current) return "unknown";
  if (!current.exhausted) return "within";
  return budget.status === "active" ? "refusing" : "over-limit-paused";
}

export function budgetRow(
  budget: Budget,
  current: BudgetPeriod | undefined,
  scope: EnvironmentScope,
): BudgetRow {
  return {
    budget,
    current,
    governsHere: governs(budget, scope),
    health: budgetHealth(budget, current),
    percent: current ? percentUsed(current.spendUsdMicros, current.amountUsdMicros) : undefined,
  };
}

export function refusingBudgets(
  entries: readonly Pick<BudgetRow, "budget" | "current">[],
  scope: EnvironmentScope,
): BudgetRefusal[] {
  return entries
    .flatMap(({ budget, current }) =>
      current && governs(budget, scope) && budgetHealth(budget, current) === "refusing"
        ? [
            {
              budget,
              current,
              percent: percentUsed(current.spendUsdMicros, current.amountUsdMicros),
            },
          ]
        : [],
    )
    .toSorted((left, right) => byAdmissionOrder(left.budget, right.budget));
}

export function parseBudgetSearch(search: Readonly<Record<string, unknown>>): BudgetSearch {
  return search.show === "all" ? { show: "all" } : {};
}

/** "Applies here" lists live budgets governing the environment; "All" keeps the API's newest-first order. */
export function budgetPage(
  budgets: readonly Budget[],
  {
    offset,
    pageSize,
    scope,
    view,
  }: {
    readonly offset: number;
    readonly pageSize: number;
    readonly scope: EnvironmentScope;
    readonly view: BudgetView;
  },
): Omit<BudgetPage, "complete" | "rows"> & { readonly budgets: readonly Budget[] } {
  const shown =
    view === "all"
      ? budgets
      : budgets
          .filter((budget) => budget.status !== "archived" && governs(budget, scope))
          .toSorted(byAdmissionOrder);
  const end = offset + pageSize;
  return {
    budgets: shown.slice(offset, end),
    hidden: budgets.length - shown.length,
    ...(end < shown.length ? { nextOffset: end } : {}),
  };
}

export const DEFAULT_THRESHOLDS = [50, 80, 100] as const;
const MAX_THRESHOLDS = 10;
const MAX_NAME_LENGTH = 120;

export function parseThresholds(text: string): Parsed<readonly number[]> {
  const tokens = text.split(/[\s,]+/u).filter((token) => token !== "");
  if (tokens.length === 0) return invalid("Enter 1 to 10 thresholds, such as 50, 80, 100");
  if (
    !tokens.every((token) => /^\d+$/u.test(token) && Number(token) >= 1 && Number(token) <= 100)
  ) {
    return invalid("Each threshold must be a whole percentage from 1 to 100");
  }
  const values = [...new Set(tokens.map(Number))].toSorted((left, right) => left - right);
  if (values.length > MAX_THRESHOLDS) return invalid("Use at most 10 thresholds");
  return { ok: true, value: values };
}

function parseName(text: string): Parsed<string> {
  const name = text.trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH
    ? { ok: true, value: name }
    : invalid("Enter a name of 1 to 120 characters");
}

export function readBudgetDraft(draft: BudgetDraft): Parsed<CreateBudgetBody> {
  const name = parseName(draft.name);
  if (!name.ok) return name;
  const amount = parseUsdAmount(draft.amount);
  if (!amount.ok) return amount;
  const thresholds = parseThresholds(draft.thresholds);
  if (!thresholds.ok) return thresholds;
  return {
    ok: true,
    value: {
      ...draft.target,
      amountUsdMicros: amount.value,
      name: name.value,
      period: draft.period,
      ...(thresholds.value.join() === DEFAULT_THRESHOLDS.join()
        ? {}
        : { thresholds: thresholds.value }),
    },
  };
}

/** Only the fields that differ from the budget as loaded, so a concurrent change elsewhere survives. */
export function budgetChanges(
  budget: Pick<Budget, "amountUsdMicros" | "name" | "thresholds">,
  edit: BudgetEdit,
): Parsed<UpdateBudgetBody> {
  const name = parseName(edit.name);
  if (!name.ok) return name;
  const amount = parseUsdAmount(edit.amount);
  if (!amount.ok) return amount;
  const thresholds = parseThresholds(edit.thresholds);
  if (!thresholds.ok) return thresholds;
  const changes = {
    ...(amount.value === budget.amountUsdMicros ? {} : { amountUsdMicros: amount.value }),
    ...(name.value === budget.name ? {} : { name: name.value }),
    ...(thresholds.value.join() === budget.thresholds.join()
      ? {}
      : { thresholds: thresholds.value }),
  };
  return Object.keys(changes).length === 0
    ? invalid("Nothing changed")
    : { ok: true, value: changes };
}

/** Whether the budget already holds every value an update sets, as after a retried update. */
export function changesApplied(
  budget: Pick<Budget, "amountUsdMicros" | "name" | "status" | "thresholds">,
  changes: UpdateBudgetBody,
): boolean {
  return (
    (changes.amountUsdMicros ?? budget.amountUsdMicros) === budget.amountUsdMicros &&
    (changes.name ?? budget.name) === budget.name &&
    (changes.status ?? budget.status) === budget.status &&
    (changes.thresholds ?? budget.thresholds).join() === budget.thresholds.join()
  );
}

/** What a change does to new runs the budget governs. */
export type AdmissionEffect = "admits" | "keeps-refusing" | "refuses-now" | "spend-unknown";

export interface AdmissionImpact {
  readonly effect: AdmissionEffect;
  /**
   * Active environments whose new runs the budget governs, as "project / environment", or "the
   * workspace in project / environment" for a workspace budget.
   */
  readonly environments: readonly string[];
}

type AdmissionState = Pick<Budget, "amountUsdMicros" | "status">;

/**
 * Admission refuses a run while an active budget's current-period spend is at or above its
 * amount, so creating, lowering, or resuming a budget can stop every run it governs at once.
 * Without the current period, as for a new target, the spend is unknown. `before` is the budget
 * an edit starts from: when it already refuses, the edit stops no run that was admitted.
 */
export function admissionImpact(
  next: TargetIds & AdmissionState,
  current: Pick<BudgetPeriod, "current" | "spendUsdMicros"> | undefined,
  projects: ShellProjects,
  before?: AdmissionState,
): AdmissionImpact {
  const environments = governedEnvironments(next, projects)
    .filter(({ environment }) => environment.status === "active")
    .map(({ environment, project, reach }) =>
      reach === "workspace"
        ? `the workspace in ${project.name} / ${environment.name}`
        : `${project.name} / ${environment.name}`,
    );
  if (next.status !== "active") return { effect: "admits", environments };
  if (!current?.current) return { effect: "spend-unknown", environments };
  const spend = current.spendUsdMicros;
  if (spend < next.amountUsdMicros) return { effect: "admits", environments };
  const refusedBefore = before?.status === "active" && spend >= before.amountUsdMicros;
  return { effect: refusedBefore ? "keeps-refusing" : "refuses-now", environments };
}

function targetName(target: TargetIds, projects: ShellProjects): string {
  switch (target.scope) {
    case "organization":
      return "organization";
    case "project":
      return (
        projects.find(({ project }) => project.id === target.projectId)?.project.name ?? "create"
      );
    case "environment":
      return (
        projects
          .flatMap(({ environments }) => environments)
          .find(({ id }) => id === target.environmentId)?.name ?? "create"
      );
    case "workspace":
      return "workspace";
  }
}

/**
 * The phrase to type before a budget change: to archive (`destructive`), for a change the console
 * knows refuses runs at once, and for any change to a budget that governs production. A spend the
 * console cannot see only warns. A new budget's phrase names its target, so widening the target
 * asks again.
 */
export function budgetConfirmation(
  target: TargetIds,
  projects: ShellProjects,
  options: {
    readonly budgetId?: string;
    readonly destructive?: boolean;
    readonly effect?: AdmissionEffect | undefined;
  },
): string | undefined {
  const governsProduction = governedEnvironments(target, projects).some(
    ({ environment }) => environment.type === "production",
  );
  if (!options.destructive && options.effect !== "refuses-now" && !governsProduction) {
    return undefined;
  }
  return options.budgetId?.slice(-8) ?? targetName(target, projects);
}
