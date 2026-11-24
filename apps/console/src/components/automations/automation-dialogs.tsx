import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  fireConsumesSchedule,
  type AutomationAction,
  type AutomationKind,
  type AutomationRow,
  type AutomationStatus,
} from "../../automations/automation-state.ts";
import { changeAutomationStatusFn, fireAutomationFn } from "../../data/automation-mutations.ts";
import { invalidateAutomations } from "../../data/automation-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import { PlatformApiError, type PlatformProblem } from "../../errors.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { FireResult, StatusChange } from "../../server/automation-actions.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Code, TextLink } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";

interface StatusChangeCopy {
  readonly description: string;
  readonly destructive: boolean;
  readonly label: string;
  readonly successMessage: string;
}

const STATUS_CHANGE_COPY: Readonly<Record<StatusChange, StatusChangeCopy>> = {
  archive: {
    description:
      "Archiving deletes the timer, so the automation never fires again. It cannot be undone.",
    destructive: true,
    label: "Archive",
    successMessage: "Automation archived",
  },
  pause: {
    description: "Pausing stops the timer. Nothing fires until you resume it.",
    destructive: false,
    label: "Pause",
    successMessage: "Automation paused",
  },
  resume: {
    description: "Resuming starts the timer again.",
    destructive: false,
    label: "Resume",
    successMessage: "Automation resumed",
  },
};

const RETRY_PROVISIONING: StatusChangeCopy = {
  description:
    "Retries creating the timer. The automation turns active once the timer exists, and stays provisioning if it cannot be created.",
  destructive: false,
  label: "Retry provisioning",
  successMessage: "Provisioning retried",
};

const FIRE_DESCRIPTIONS: Readonly<Record<AutomationKind, string>> = {
  heartbeat:
    "Starts one heartbeat now, outside its interval. The result shows the run it started or why it was skipped.",
  schedule:
    "Fires the schedule once now, outside its timer. The result shows the run it started or why it started none.",
};

const TIMER_NOT_CREATED = {
  detail:
    "The timer was not created; the automation stays provisioning. Close this dialog and use Retry provisioning on the detail page.",
  title: "Timer not created",
};

/** Codes from the automation service, in the console's words. */
const AUTOMATION_PROBLEMS: Readonly<Record<string, Pick<PlatformProblem, "detail" | "title">>> = {
  automation_archived: {
    detail: "An archived automation cannot fire, pause, or resume.",
    title: "Already archived",
  },
  deployment_unavailable: {
    detail: "The deployment is not ready and running; start it first.",
    title: "Deployment unavailable",
  },
  release_unavailable: {
    detail: "The deployment's release is no longer active, so it cannot start runs.",
    title: "Release unavailable",
  },
  thread_archived: {
    detail:
      "The thread this automation continues is archived, so no run can start there. The automation may now be archived too.",
    title: "Thread archived",
  },
  timer_provider_unavailable: TIMER_NOT_CREATED,
  timer_provisioning_conflict: TIMER_NOT_CREATED,
  trigger_not_allowed: {
    detail: "The deployment's release does not allow runs from this kind of automation.",
    title: "Trigger not allowed",
  },
  workspace_unavailable: {
    detail: "The automation's workspace is not active.",
    title: "Workspace unavailable",
  },
};

function statusChangeCopy(change: StatusChange, status: AutomationStatus): StatusChangeCopy {
  return change === "resume" && status === "provisioning"
    ? RETRY_PROVISIONING
    : STATUS_CHANGE_COPY[change];
}

/** The button and dialog label of an action; resuming a provisioning automation retries it. */
export function actionLabel(action: AutomationAction, status: AutomationStatus): string {
  return action === "fire" ? "Fire now" : statusChangeCopy(action, status).label;
}

interface AutomationMutations {
  readonly environmentType: EnvironmentSummary["type"];
  readonly refresh: () => Promise<void>;
  /**
   * Runs one mutation. A 409 means the automation changed since it was read, so it is re-read;
   * known automation codes get the console's wording before the dialog shows them.
   */
  readonly submit: <Result>(mutation: Promise<Result>) => Promise<Result>;
}

function useAutomationMutations(scope: EnvironmentScope): AutomationMutations {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = () => invalidateAutomations(queryClient, scope);
  return {
    environmentType: environment.type,
    refresh,
    async submit(mutation) {
      try {
        return await mutation;
      } catch (error) {
        if (!(error instanceof PlatformApiError)) throw error;
        if (error.problem.status === 409) void refresh();
        const copy = error.problem.code ? AUTOMATION_PROBLEMS[error.problem.code] : undefined;
        throw copy ? new PlatformApiError(error.operation, { ...error.problem, ...copy }) : error;
      }
    },
  };
}

interface DialogProps {
  readonly mutations: AutomationMutations;
  readonly onClose: () => void;
  readonly open: boolean;
  /** Typed to confirm: a schedule's name, or a heartbeat's ID tail since heartbeats have none. */
  readonly phrase: string;
  readonly row: AutomationRow;
  readonly scope: EnvironmentScope;
}

function StatusChangeDialog({
  change,
  mutations,
  onClose,
  open,
  phrase,
  row,
  scope,
}: DialogProps & { readonly change: StatusChange }) {
  const copy = statusChangeCopy(change, row.status);
  return (
    <ActionDialog
      confirmLabel={copy.label}
      confirmation={typedConfirmation(mutations.environmentType, {
        destructive: copy.destructive,
        phrase,
      })}
      description={copy.description}
      destructive={copy.destructive}
      onClose={onClose}
      onSuccess={() => void mutations.refresh()}
      open={open}
      runOnce={() =>
        mutations.submit(
          changeAutomationStatusFn({ data: { change, id: row.id, kind: row.kind, scope } }),
        )
      }
      successMessage={copy.successMessage}
      title={`${copy.label}: ${row.label}`}
    />
  );
}

function FireDialog({
  mutations,
  onClose,
  onFired,
  open,
  phrase,
  row,
  scope,
}: DialogProps & { readonly onFired: (result: FireResult) => void }) {
  const queryClient = useQueryClient();
  const consumes = fireConsumesSchedule(row);
  return (
    <ActionDialog<FireResult>
      confirmLabel="Fire now"
      confirmation={typedConfirmation(mutations.environmentType, {
        destructive: consumes,
        phrase,
      })}
      description={FIRE_DESCRIPTIONS[row.kind]}
      destructive={consumes}
      onClose={onClose}
      onSuccess={(result) => {
        onFired(result);
        void mutations.refresh();
        void invalidateRuntime(queryClient, scope);
      }}
      open={open}
      run={(idempotencyKey) =>
        mutations.submit(
          fireAutomationFn({
            data: {
              agentDeploymentId: row.agentDeploymentId,
              id: row.id,
              idempotencyKey,
              kind: row.kind,
              scope,
            },
          }),
        )
      }
      successMessage={(result) => (result.run ? "Run started" : "No run started")}
      title={`Fire now: ${row.label}`}
    >
      {consumes ? (
        <Callout variant="destructive">
          <CalloutTitle>This fire uses up the schedule</CalloutTitle>
          <CalloutDescription>
            A one-time schedule is archived after any fire, even a fire that starts no run.
          </CalloutDescription>
        </Callout>
      ) : null}
    </ActionDialog>
  );
}

/** One dialog per action the caller may take on `row`; `dialog` opens one of them. */
export function AutomationDialogs({
  actions,
  dialog,
  onClose,
  onFired,
  row,
  scope,
}: Readonly<{
  actions: readonly AutomationAction[];
  dialog: AutomationAction | undefined;
  onClose: () => void;
  onFired: (result: FireResult) => void;
  row: AutomationRow;
  scope: EnvironmentScope;
}>) {
  const mutations = useAutomationMutations(scope);
  const shared = {
    mutations,
    onClose,
    phrase: row.kind === "schedule" ? row.label : row.id.slice(-8),
    row,
    scope,
  };
  return actions.map((action) =>
    action === "fire" ? (
      <FireDialog {...shared} key={action} onFired={onFired} open={dialog === action} />
    ) : (
      <StatusChangeDialog {...shared} change={action} key={action} open={dialog === action} />
    ),
  );
}

export function FireResultCallout({
  result,
  scope,
}: Readonly<{ result: FireResult; scope: EnvironmentScope }>) {
  const basePath = environmentPath(scope);
  const { run } = result;
  return (
    <Callout>
      <CalloutTitle>{run ? "Run started" : "No run started"}</CalloutTitle>
      <CalloutDescription>
        {run ? (
          <p>
            Run{" "}
            <TextLink href={`${basePath}/runs/${run.runId}`} title={`Run ${run.runId}`}>
              <Code>…{run.runId.slice(-8)}</Code>
            </TextLink>{" "}
            in thread{" "}
            <TextLink
              href={`${basePath}/threads/${run.threadId}?run=${run.runId}`}
              title={`Thread ${run.threadId}`}
            >
              <Code>…{run.threadId.slice(-8)}</Code>
            </TextLink>
            .
          </p>
        ) : (
          <p>{result.fire.reason ?? "The platform recorded no reason."}</p>
        )}
      </CalloutDescription>
    </Callout>
  );
}
