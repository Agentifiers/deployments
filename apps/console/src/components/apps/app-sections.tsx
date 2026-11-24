import type { AppResponse } from "@deployments-ai/api-contract";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { AppWrites } from "../../apps/app-state.ts";
import { AUDIENCE_CHOICES, publicationNotice, SERVING_CHOICES } from "../../apps/publication.ts";
import { appGrantsQuery, appReleasePagesQuery } from "../../data/app-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { formatByteSize } from "../../runs/views.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import type { AppDialog } from "./app-dialogs.tsx";

interface SectionProps {
  readonly appId: string;
  readonly onDialog: (dialog: AppDialog) => void;
  readonly scope: EnvironmentScope;
  readonly writes: AppWrites;
}

export function Refusal({ reason }: Readonly<{ reason: string | undefined }>) {
  return reason ? <p className="text-xs/5 text-muted-foreground">{reason}</p> : null;
}

export function AppPublication({
  app,
  onDialog,
  writes,
}: Readonly<{ app: AppResponse; onDialog: (dialog: AppDialog) => void; writes: AppWrites }>) {
  const change = writes.setAppPublication;
  const audience = AUDIENCE_CHOICES[app.publication.audience];
  const serving = SERVING_CHOICES[app.publication.serving];
  const notice = publicationNotice(app);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Publication</Subheading>
        {change ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <Button
              disabled={!change.enabled}
              onClick={() => onDialog({ kind: "publication" })}
              variant="outline"
            >
              Change
            </Button>
            <Refusal reason={change.enabled ? undefined : change.reason} />
          </div>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionTerm>Audience</DescriptionTerm>
        <DescriptionDetails>
          <span className="flex flex-col gap-1">
            <span>{audience.label}</span>
            <Text>{audience.description}</Text>
          </span>
        </DescriptionDetails>
        <DescriptionTerm>Serving</DescriptionTerm>
        <DescriptionDetails>
          <span className="flex flex-col gap-1">
            <span>{serving.label}</span>
            <Text>{serving.description}</Text>
          </span>
        </DescriptionDetails>
      </DescriptionList>
      {notice ? (
        <Callout variant="warning">
          <CalloutDescription>{notice}</CalloutDescription>
        </Callout>
      ) : null}
    </section>
  );
}
export function AppGrants({ appId, onDialog, scope, writes }: SectionProps) {
  const { data } = useSuspenseQuery(appGrantsQuery(scope, appId));
  const add = writes.putAppGrant;
  const remove = writes.removeAppGrant;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Grants</Subheading>
        {add ? (
          <div className="ml-auto flex flex-col items-end gap-1">
            <Button
              disabled={!add.enabled || data.candidates.length === 0}
              onClick={() => onDialog({ kind: "add-grant" })}
              variant="outline"
            >
              <Icon icon={PlusSignIcon} />
              Add grant
            </Button>
            <Refusal reason={add.enabled ? undefined : add.reason} />
          </div>
        ) : null}
      </div>
      {data.grants.length === 0 ? (
        <Text>No grants. Members get the access level above.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Updated</TableHead>
              {remove ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.grants.map((grant) => (
              <TableRow key={grant.principalId}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {grant.name}
                    {grant.memberActive ? null : <Badge color="zinc">not an active member</Badge>}
                  </span>
                </TableCell>
                <TableCell>{grant.role}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={grant.updatedAt} />
                </TableCell>
                {remove ? (
                  <TableCell className="text-right">
                    <Button
                      disabled={!remove.enabled}
                      onClick={() => onDialog({ grant, kind: "remove-grant" })}
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {remove && !remove.enabled ? <Refusal reason={remove.reason} /> : null}
    </section>
  );
}

export function AppReleases({ appId, onDialog, scope, writes }: SectionProps) {
  const query = appReleasePagesQuery(scope, appId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const releases = data.pages.flatMap((page) => page.items);
  const promote = writes.promoteAppRelease;
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Releases</Subheading>
      {releases.length === 0 ? (
        <Text>No releases yet. The agent publishes one with app.release.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Files</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>
                <span className="sr-only">Status</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release) => (
              <TableRow key={release.id}>
                <TableCell>
                  <PublicId value={release.id} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={release.createdAt} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatExact(release.files)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatByteSize(release.bytes)}
                </TableCell>
                <TableCell>
                  <PublicId value={release.runId} />
                </TableCell>
                <TableCell className="text-right">
                  {release.live ? (
                    <Badge color="green">live</Badge>
                  ) : promote ? (
                    <Button
                      disabled={!promote.enabled}
                      onClick={() => onDialog({ kind: "promote", release })}
                      variant="ghost"
                    >
                      Promote
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {promote && !promote.enabled ? <Refusal reason={promote.reason} /> : null}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={query.queryKey}
      />
    </section>
  );
}
