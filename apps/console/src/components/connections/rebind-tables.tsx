import type { GrantUse } from "../../connections/connection-state.ts";
import type { EarlierRevocation, GrantTemplate } from "../../connections/rebind.ts";
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
import { GrantWorkspace } from "./grant-workspace.tsx";

function templateState(template: GrantTemplate) {
  if (template.skipped) return "Skipped";
  if (template.replacement) return "Restored";
  return template.missingScopes.length > 0
    ? `Missing ${template.missingScopes.join(", ")}`
    : "Pending";
}

function Pins({ uses }: Readonly<{ uses: readonly GrantUse[] }>) {
  if (uses.length === 0) return "None";
  return (
    <ul className="flex flex-col gap-1">
      {uses.map((use) => (
        <li className="flex items-center gap-2" key={`${use.deploymentId}:${use.toolName}`}>
          <PublicId value={use.deploymentId} />
          <Code>{use.toolName}</Code>
        </li>
      ))}
    </ul>
  );
}

export function TemplateTable({
  busy,
  canEdit,
  onToggleSkip,
  templates,
  workspaces,
}: Readonly<{
  busy: boolean;
  canEdit: boolean;
  onToggleSkip: (template: GrantTemplate) => void;
  templates: readonly GrantTemplate[];
  workspaces: ReadonlyMap<string, string>;
}>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Workspace</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Pinned by</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Replacement</TableHead>
          {canEdit ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {templates.map((template) => (
          <TableRow key={template.grant.id}>
            <TableCell>
              <GrantWorkspace names={workspaces} workspaceId={template.grant.workspaceId} />
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal">
              <Code>{template.grant.scopes.join(", ") || "None"}</Code>
            </TableCell>
            <TableCell>
              <Pins uses={template.pinnedBy} />
            </TableCell>
            <TableCell>{templateState(template)}</TableCell>
            <TableCell>
              {template.replacement ? <PublicId value={template.replacement.id} /> : "None yet"}
            </TableCell>
            {canEdit ? (
              <TableCell className="text-right">
                {template.replacement ? null : (
                  <Button disabled={busy} onClick={() => onToggleSkip(template)} variant="ghost">
                    {template.skipped ? "Restore" : "Skip"}
                  </Button>
                )}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function EarlierTable({
  busy,
  canEdit,
  earlier,
  onToggle,
  workspaces,
}: Readonly<{
  busy: boolean;
  canEdit: boolean;
  earlier: readonly EarlierRevocation[];
  onToggle: (revocation: EarlierRevocation) => void;
  workspaces: ReadonlyMap<string, string>;
}>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Workspace</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Pinned by</TableHead>
          <TableHead>Revoked</TableHead>
          <TableHead>Restore</TableHead>
          {canEdit ? <TableHead /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {earlier.map((revocation) => (
          <TableRow key={revocation.grant.id}>
            <TableCell>
              <GrantWorkspace names={workspaces} workspaceId={revocation.grant.workspaceId} />
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal">
              <Code>{revocation.grant.scopes.join(", ") || "None"}</Code>
            </TableCell>
            <TableCell>
              <Pins uses={revocation.pinnedBy} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Timestamp value={revocation.grant.updatedAt} />
            </TableCell>
            <TableCell>{revocation.included ? "Yes" : "No"}</TableCell>
            {canEdit ? (
              <TableCell className="text-right">
                <Button disabled={busy} onClick={() => onToggle(revocation)} variant="ghost">
                  {revocation.included ? "Leave revoked" : "Restore"}
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
