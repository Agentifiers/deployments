import {
  Archive02Icon,
  ArrowLeft01Icon,
  FlashIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  AUTOMATION_KINDS,
  availableActions,
  resumeBlockedReason,
  type AutomationAction,
  type AutomationRow,
} from "../../automations/automation-state.ts";
import {
  describeCadence,
  nextScheduleFires,
  type ActiveWindow,
} from "../../automations/cadence.ts";
import { automationQuery } from "../../data/automation-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { AutomationRef } from "../../server/automation-data.ts";
import type { FireResult } from "../../server/automation-actions.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AutomationDialogs, actionLabel, FireResultCallout } from "./automation-dialogs.tsx";
import { EditHeartbeatDialog, EditScheduleDialog } from "./automation-form-dialogs.tsx";
import {
  HealthBadge,
  KindBadge,
  LastFireText,
  NextFireText,
  OriginText,
  ThreadText,
} from "./automation-table.tsx";
import { FireTable } from "./fire-table.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_ICONS: Readonly<Record<AutomationAction, IconSvgElement>> = {
  archive: Archive02Icon,
  fire: FlashIcon,
  pause: PauseIcon,
  resume: PlayIcon,
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockTime(minuteOfDay: number) {
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  return `${hours}:${String(minuteOfDay % 60).padStart(2, "0")}`;
}

function activeWindowText(window: ActiveWindow | undefined) {
  if (!window) return "Always";
  const days = window.daysOfWeek
    ? window.daysOfWeek.map((day) => DAY_NAMES[day] ?? String(day)).join(", ")
    : "every day";
  return `${clockTime(window.startMinuteOfDay)}-${clockTime(window.endMinuteOfDay)}, ${days}`;
}

/** A schedule's next three fires, stepped from its next fire so a `rate()` keeps its anchor. */
function NextFires({ row }: Readonly<{ row: AutomationRow }>) {
  const { cadence, nextFire } = row;
  if (cadence.kind !== "schedule" || nextFire.kind !== "at") {
    return <NextFireText nextFire={nextFire} />;
  }
  const later = nextScheduleFires(cadence, new Date(nextFire.at), 2, {
    scheduledFor: nextFire.at,
  });
  return (
    <ol className="flex flex-col gap-1">
      {[nextFire.at, ...later].map((at) => (
        <li key={at}>
          <NextFireText nextFire={{ ...nextFire, at }} />
        </li>
      ))}
    </ol>
  );
}

function Collapsed({ label, text }: Readonly<{ label: string; text: string }>) {
  return (
    <details>
      <summary className="cursor-pointer">{label}</summary>
      <pre className="mt-2 font-sans text-sm/6 break-words whitespace-pre-wrap">{text}</pre>
    </details>
  );
}

function AutomationDetail({
  automation,
  scope,
}: Readonly<{ automation: AutomationRef; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const {
    data: { entry, row },
  } = useSuspenseQuery(automationQuery(scope, automation));
  const [dialog, setDialog] = useState<AutomationAction>();
  const [editing, setEditing] = useState(false);
  const [fireResult, setFireResult] = useState<FireResult>();
  const { access } = shell;
  const allowed = availableActions(row, access);
  const resumeBlocked = allowed.includes("resume")
    ? resumeBlockedReason(row, new Date())
    : undefined;
  const actions = resumeBlocked ? allowed.filter((action) => action !== "resume") : allowed;
  const canEdit =
    row.status !== "archived" &&
    row.status !== "disabled" &&
    access[entry.kind === "schedule" ? "updateSchedule" : "updateHeartbeat"];
  const { cadence } = row;
  const record = entry.kind === "schedule" ? entry.schedule : entry.heartbeat;
  const deploymentLabel = agentLabels(directory).deployment(row.agentDeploymentId);
  const definitionId = directory.deployments.find(
    (deployment) => deployment.id === row.agentDeploymentId,
  )?.definitionId;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{row.label}</Heading>
        <KindBadge kind={row.kind} />
        <StatusBadge status={row.status} />
        <HealthBadge health={row.health} />
        <div className="ml-auto flex flex-wrap gap-3">
          {canEdit ? (
            <Button onClick={() => setEditing(true)} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Edit
            </Button>
          ) : null}
          {actions.map((action) => {
            const content = (
              <>
                <Icon icon={ACTION_ICONS[action]} />
                {actionLabel(action, row.status)}
              </>
            );
            return action === "archive" ? (
              <Button variant="destructive" key={action} onClick={() => setDialog(action)}>
                {content}
              </Button>
            ) : (
              <Button key={action} onClick={() => setDialog(action)} variant="outline">
                {content}
              </Button>
            );
          })}
        </div>
      </div>
      {resumeBlocked ? (
        <Callout>
          <CalloutTitle>Cannot resume</CalloutTitle>
          <CalloutDescription>{resumeBlocked}</CalloutDescription>
        </Callout>
      ) : null}
      {fireResult ? <FireResultCallout result={fireResult} scope={scope} /> : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={row.id} />
        </DescriptionDetails>
        <DescriptionTerm>Deployment</DescriptionTerm>
        <DescriptionDetails>
          {definitionId ? (
            <TextLink href={`${environmentPath(scope)}/agents/${definitionId}/runs`}>
              {deploymentLabel}
            </TextLink>
          ) : (
            deploymentLabel
          )}
        </DescriptionDetails>
        <DescriptionTerm>Cadence</DescriptionTerm>
        <DescriptionDetails>{describeCadence(cadence)}</DescriptionDetails>
        {cadence.kind === "schedule" ? (
          <>
            <DescriptionTerm>Expression</DescriptionTerm>
            <DescriptionDetails>
              <Code>{cadence.raw}</Code>
            </DescriptionDetails>
          </>
        ) : (
          <>
            <DescriptionTerm>Active window</DescriptionTerm>
            <DescriptionDetails>{activeWindowText(cadence.window)}</DescriptionDetails>
            <DescriptionTerm>While the deployment is busy</DescriptionTerm>
            <DescriptionDetails>
              {cadence.skipWhenBusy ? "Skipped" : "Fires anyway"}
            </DescriptionDetails>
          </>
        )}
        <DescriptionTerm>Time zone</DescriptionTerm>
        <DescriptionDetails>{cadence.timeZone}</DescriptionDetails>
        <DescriptionTerm>
          {cadence.kind === "schedule" ? "Next fires" : "Next fire"}
        </DescriptionTerm>
        <DescriptionDetails>
          <NextFires row={row} />
        </DescriptionDetails>
        <DescriptionTerm>Last fire</DescriptionTerm>
        <DescriptionDetails>
          <LastFireText lastFire={row.lastFire} />
          {row.lastFire.kind === "fired" && row.lastFire.fire.reason ? (
            <p>{row.lastFire.fire.reason}</p>
          ) : null}
        </DescriptionDetails>
        <DescriptionTerm>Thread</DescriptionTerm>
        <DescriptionDetails>
          <ThreadText scope={scope} thread={row.thread} />
        </DescriptionDetails>
        <DescriptionTerm>Origin</DescriptionTerm>
        <DescriptionDetails>
          <OriginText origin={row.origin} scope={scope} />
        </DescriptionDetails>
        <DescriptionTerm>Workspace</DescriptionTerm>
        <DescriptionDetails>
          {record.workspaceId ? <PublicId value={record.workspaceId} /> : "—"}
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={record.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={row.updatedAt} />
        </DescriptionDetails>
        {entry.kind === "schedule" ? (
          <>
            <DescriptionTerm>Prompt</DescriptionTerm>
            <DescriptionDetails>
              {entry.schedule.prompt ? (
                <Collapsed label="Show prompt" text={entry.schedule.prompt} />
              ) : (
                "—"
              )}
            </DescriptionDetails>
          </>
        ) : (
          <>
            <DescriptionTerm>Instructions</DescriptionTerm>
            <DescriptionDetails>
              <Collapsed label="Show instructions" text={entry.heartbeat.schedule.instructions} />
            </DescriptionDetails>
          </>
        )}
      </DescriptionList>
      {access[AUTOMATION_KINDS[row.kind].operations.listFires] ? (
        <section className="flex flex-col gap-4">
          <Subheading>Fires</Subheading>
          <SectionBoundary resetKey={row.id}>
            <FireTable automation={row} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
      {canEdit && entry.kind === "schedule" ? (
        <EditScheduleDialog
          key={String(editing)}
          onClose={() => setEditing(false)}
          open={editing}
          schedule={entry.schedule}
          scope={scope}
        />
      ) : null}
      {canEdit && entry.kind === "heartbeat" ? (
        <EditHeartbeatDialog
          heartbeat={entry.heartbeat}
          key={String(editing)}
          label={row.label}
          onClose={() => setEditing(false)}
          open={editing}
          scope={scope}
        />
      ) : null}
      <AutomationDialogs
        actions={actions}
        dialog={dialog}
        onClose={() => setDialog(undefined)}
        onFired={setFireResult}
        row={row}
        scope={scope}
      />
    </div>
  );
}

/** A schedule or heartbeat page; the back link stays while the detail loads or fails. */
export function AutomationDetailPage({
  automation,
  scope,
}: Readonly<{ automation: AutomationRef; scope: EnvironmentScope }>) {
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{
          envId: scope.environmentId,
          orgId: scope.organizationId,
          projectId: scope.projectId,
        }}
        to="/o/$orgId/p/$projectId/e/$envId/automations"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Automations
      </Link>
      <SectionBoundary resetKey={automation.id}>
        <AutomationDetail automation={automation} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
