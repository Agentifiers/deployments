import { ALL_PLAN_FEATURES } from "@deployments-ai/api-contract/plan-features";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { systemStandingHistoryQuery, systemStandingQuery } from "../../data/system-queries.ts";
import type { SystemStanding, SystemStandingChange } from "../../server/system-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import {
  Timeline,
  TimelineContent,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
} from "@/components/reui/timeline";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import {
  ceilingText,
  ClearEntitlementsDialog,
  EntitlementsEditor,
  featureText,
} from "./entitlement-dialogs.tsx";
import { PLAN_FEATURE_FIELDS, TENANT_LIMITS, type EntitlementGrant } from "./entitlement-draft.ts";
import { ClearDataBoundaryDialog, SetDataBoundaryDialog } from "./data-boundary-dialogs.tsx";
import { PlaceHoldDialog, ReleaseHoldDialog, type StandingHold } from "./hold-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

type Actor = SystemStanding["holds"][number]["placedBy"];

function actorText(actor: Actor) {
  return actor.kind === "operator"
    ? `operator …${actor.principalId.slice(-8)}`
    : `service ${actor.service}`;
}

type StandingDialog =
  | { readonly kind: "place-hold" }
  | { readonly kind: "release-hold"; readonly hold: StandingHold }
  | { readonly kind: "edit-entitlements" }
  | { readonly kind: "clear-entitlements" }
  | { readonly kind: "set-data-boundary" }
  | { readonly kind: "clear-data-boundary" };

function grantText(grant: EntitlementGrant): string {
  const parts = [
    ...(grant.operatorFundedModelSpendCeiling === undefined
      ? []
      : [`spend ${ceilingText(grant.operatorFundedModelSpendCeiling)}`]),
    ...PLAN_FEATURE_FIELDS.flatMap(({ label, name }) => {
      const enabled = grant.features?.[name];
      return enabled === undefined ? [] : [`${label} ${featureText(enabled).toLowerCase()}`];
    }),
    ...TENANT_LIMITS.flatMap(({ label, name }) => {
      const value = grant.tenantLimits?.[name];
      return value === undefined ? [] : [`${label.toLowerCase()} ${value}`];
    }),
  ];
  return parts.length === 0 ? "sets nothing" : parts.join(", ");
}

/**
 * Holds, the data boundary, grants, and effective entitlements, with every standing change an
 * operator makes.
 */
export function OrganizationStanding({
  organizationId,
  slug,
}: Readonly<{ organizationId: string; slug: string }>) {
  const { data: standing } = useSuspenseQuery(systemStandingQuery(organizationId));
  const [dialog, setDialog] = useState<StandingDialog>();
  const close = () => setDialog(undefined);
  const operatorHolds = standing.holds.filter((hold) => hold.source === "operator");
  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Holds</Subheading>
          <StatusBadge status={standing.state} />
          {standing.suspendedAt ? (
            <Text>
              since <Timestamp value={standing.suspendedAt} />
            </Text>
          ) : null}
          <Button
            className="ml-auto"
            onClick={() => setDialog({ kind: "place-hold" })}
            variant="destructive"
          >
            Place hold
          </Button>
        </div>
        {standing.holds.length === 0 ? (
          <Text>No holds. The organization is active.</Text>
        ) : (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Hold</TableHead>
                <TableHead>Customer message</TableHead>
                <TableHead>Operator note</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {standing.holds.map((hold) => (
                <TableRow key={`${hold.source}/${hold.key}`}>
                  <TableCell>
                    <Code>{hold.key}</Code>
                    <div className="text-xs text-muted-foreground">
                      {hold.reason} · {hold.source}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    {hold.customerMessage}
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    {hold.operatorNote ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={hold.placedAt} />
                    <div className="text-xs text-muted-foreground">{actorText(hold.placedBy)}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {hold.source === "operator" ? (
                      <Button
                        onClick={() => setDialog({ hold, kind: "release-hold" })}
                        size="sm"
                        variant="outline"
                      >
                        Release
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Released by its service</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Data boundary</Subheading>
          {standing.dataBoundary ? (
            <Badge color="amber">{standing.dataBoundary.profile}</Badge>
          ) : null}
          <div className="ml-auto">
            {standing.dataBoundary ? (
              <Button
                onClick={() => setDialog({ kind: "clear-data-boundary" })}
                variant="destructive"
              >
                Clear boundary
              </Button>
            ) : (
              <Button onClick={() => setDialog({ kind: "set-data-boundary" })}>Set boundary</Button>
            )}
          </div>
        </div>
        {standing.dataBoundary ? (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Profile</TableHead>
                <TableHead>Operator note</TableHead>
                <TableHead>Set</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>
                  <Code>{standing.dataBoundary.profile}</Code>
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  {standing.dataBoundary.operatorNote}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={standing.dataBoundary.setAt} />
                  <div className="text-xs text-muted-foreground">
                    {actorText(standing.dataBoundary.setBy)}
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        ) : (
          <Text>No data boundary. Tools and models are limited only by the release.</Text>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Entitlements</Subheading>
          <div className="ml-auto flex gap-2">
            {standing.grants.operator ? (
              <Button
                onClick={() => setDialog({ kind: "clear-entitlements" })}
                variant="destructive"
              >
                Clear operator grant
              </Button>
            ) : null}
            <Button onClick={() => setDialog({ kind: "edit-entitlements" })}>
              {standing.grants.operator ? "Edit operator grant" : "Set operator grant"}
            </Button>
          </div>
        </div>
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead>Effective</TableHead>
              <TableHead>Operator grant</TableHead>
              <TableHead>Service grant</TableHead>
              <TableHead>Install default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Operator-funded model spend</TableCell>
              <TableCell className="font-medium">
                {ceilingText(standing.effective.operatorFundedModelSpendCeiling)}
              </TableCell>
              {[standing.grants.operator, standing.grants.service].map((grant, index) => {
                const ceiling = grant?.entitlements.operatorFundedModelSpendCeiling;
                return <TableCell key={index}>{ceiling ? ceilingText(ceiling) : "—"}</TableCell>;
              })}
              <TableCell>
                {ceilingText(standing.defaults.operatorFundedModelSpendCeiling)}
              </TableCell>
            </TableRow>
            {PLAN_FEATURE_FIELDS.map(({ label, name }) => (
              <TableRow key={name}>
                <TableCell>{label}</TableCell>
                <TableCell className="font-medium">
                  {featureText(standing.effective.features[name])}
                </TableCell>
                {[standing.grants.operator, standing.grants.service].map((grant, index) => {
                  const enabled = grant?.entitlements.features?.[name];
                  return (
                    <TableCell key={index}>
                      {enabled === undefined ? "—" : featureText(enabled)}
                    </TableCell>
                  );
                })}
                <TableCell>{featureText(ALL_PLAN_FEATURES[name])}</TableCell>
              </TableRow>
            ))}
            {TENANT_LIMITS.map(({ label, name }) => (
              <TableRow key={name}>
                <TableCell>{label}</TableCell>
                <TableCell className="font-medium tabular-nums">
                  {standing.effective.tenantLimits[name]}
                </TableCell>
                <TableCell className="tabular-nums">
                  {standing.grants.operator?.entitlements.tenantLimits?.[name] ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {standing.grants.service?.entitlements.tenantLimits?.[name] ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {standing.defaults.tenantLimits[name]}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {standing.grants.operator ? (
          <Text>
            Operator grant set <Timestamp value={standing.grants.operator.grantedAt} /> by{" "}
            {actorText(standing.grants.operator.grantedBy)}.
          </Text>
        ) : null}
        {standing.grants.service ? (
          <Text>
            Service grant set <Timestamp value={standing.grants.service.grantedAt} /> by{" "}
            {actorText(standing.grants.service.grantedBy)}.
          </Text>
        ) : null}
      </section>

      {dialog?.kind === "place-hold" ? (
        <PlaceHoldDialog
          confirmation={slug}
          existingKeys={operatorHolds.map((hold) => hold.key)}
          onClose={close}
          organizationId={organizationId}
        />
      ) : null}
      {dialog?.kind === "release-hold" ? (
        <ReleaseHoldDialog hold={dialog.hold} onClose={close} organizationId={organizationId} />
      ) : null}
      {dialog?.kind === "set-data-boundary" ? (
        <SetDataBoundaryDialog onClose={close} organizationId={organizationId} />
      ) : null}
      {dialog?.kind === "clear-data-boundary" && standing.dataBoundary ? (
        <ClearDataBoundaryDialog
          confirmation={slug}
          onClose={close}
          organizationId={organizationId}
          profile={standing.dataBoundary.profile}
        />
      ) : null}
      {dialog?.kind === "edit-entitlements" ? (
        <EntitlementsEditor onClose={close} organizationId={organizationId} standing={standing} />
      ) : null}
      {dialog?.kind === "clear-entitlements" ? (
        <ClearEntitlementsDialog
          confirmation={slug}
          onClose={close}
          organizationId={organizationId}
          standing={standing}
        />
      ) : null}
    </div>
  );
}

function changeText(change: SystemStandingChange["change"]): string {
  switch (change.kind) {
    case "hold-placed":
      return `Placed ${change.hold.reason} hold ${change.hold.key} (${change.hold.source})`;
    case "hold-released":
      return `Released hold ${change.hold.key} (${change.hold.source})${change.releaseNote ? `: ${change.releaseNote}` : ""}`;
    case "grant-set":
      return `Set grant: ${grantText(change.entitlements)}`;
    case "grant-cleared":
      return "Cleared grant";
    case "data-boundary-set":
      return `Set ${change.dataBoundary.profile} data boundary: ${change.dataBoundary.operatorNote}`;
    case "data-boundary-cleared":
      return `Cleared ${change.profile} data boundary: ${change.operatorNote}`;
  }
}

/** Standing changes, newest first. */
export function StandingHistory({ organizationId }: Readonly<{ organizationId: string }>) {
  const pagesQuery = systemStandingHistoryQuery(organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const changes = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {changes.length === 0 ? (
        <Text>No standing changes yet.</Text>
      ) : (
        <Timeline aria-label="Standing history" render={<ol />} value={changes.length}>
          {changes.map((item, index) => (
            <TimelineItem key={item.version} render={<li />} step={index + 1}>
              <TimelineHeader>
                <TimelineSeparator />
                <TimelineIndicator />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{changeText(item.change)}</span>
                  <StatusBadge status={item.state} />
                </div>
              </TimelineHeader>
              <TimelineContent className="text-xs">
                v{item.version} · <Timestamp value={item.occurredAt} /> · {actorText(item.actor)}
                {item.change.kind === "hold-placed"
                  ? ` · "${item.change.hold.customerMessage}"`
                  : ""}
              </TimelineContent>
            </TimelineItem>
          ))}
        </Timeline>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
