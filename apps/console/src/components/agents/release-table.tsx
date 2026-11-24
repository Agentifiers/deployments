import type { AgentDetail, AgentReleaseSummary } from "../../server/agent-data.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { releaseInUse } from "./archive-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

/** `sha256:` plus the first twelve hex digits; the full hash is in the tooltip. */
export function ContentHash({ value }: Readonly<{ value: string }>) {
  return (
    <Code className="whitespace-nowrap" title={value}>
      {value.slice(0, "sha256:".length + 12)}…
    </Code>
  );
}

/** Deployments of this agent that pin the release or run it as a canary candidate. */
function ReleaseDeployments({
  agent,
  releaseId,
}: Readonly<{ agent: AgentDetail; releaseId: string }>) {
  const uses = agent.deployments.flatMap((deployment) => {
    if (deployment.agentReleaseId === releaseId) return [{ deployment, role: "pinned" }];
    if (deployment.candidateAgentReleaseId === releaseId) {
      return [{ deployment, role: `canary ${deployment.candidateWeight ?? 0}%` }];
    }
    return [];
  });
  if (uses.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-col gap-1">
      {uses.map(({ deployment, role }) => (
        <li className="flex flex-wrap items-center gap-2" key={deployment.id}>
          <PublicId value={deployment.id} />
          <Badge color={role === "pinned" ? "zinc" : "amber"}>{role}</Badge>
          <StatusBadge status={deployment.currentState} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent's releases newest first, with the deployments that use each one. A release a live
 * deployment uses cannot be archived, so it offers no archive action.
 */
export function ReleaseTable({
  agent,
  canArchive,
  canPromote,
  onArchive,
  onPromote,
  onShow,
  selectedId,
}: Readonly<{
  agent: AgentDetail;
  canArchive: boolean;
  canPromote: boolean;
  onArchive: (release: AgentReleaseSummary) => void;
  onPromote: (release: AgentReleaseSummary) => void;
  onShow: (releaseId: string) => void;
  selectedId: string | undefined;
}>) {
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Release</TableHead>
          <TableHead>Content hash</TableHead>
          <TableHead>Created by</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Deployments</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agent.releases.map((release) => (
          <TableRow className={release.id === selectedId ? "bg-muted" : undefined} key={release.id}>
            <TableCell className="font-medium whitespace-nowrap">
              #{release.releaseNumber}
              <div>
                <PublicId value={release.id} />
              </div>
            </TableCell>
            <TableCell>
              <ContentHash value={release.contentHash} />
            </TableCell>
            <TableCell>
              <PublicId value={release.createdByPrincipalId} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={release.createdAt} />
            </TableCell>
            <TableCell>
              <StatusBadge status={release.status} />
            </TableCell>
            <TableCell>
              <ReleaseDeployments agent={agent} releaseId={release.id} />
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              <div className="flex justify-end gap-2">
                <Button onClick={() => onShow(release.id)} variant="ghost">
                  Details
                </Button>
                {canPromote && release.status === "active" ? (
                  <Button onClick={() => onPromote(release)} variant="outline">
                    Copy to environment…
                  </Button>
                ) : null}
                {canArchive && release.status === "active" && !releaseInUse(agent, release.id) ? (
                  <Button onClick={() => onArchive(release)} variant="ghost">
                    Archive
                  </Button>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
