import type { ToolBinding } from "../../../agents/runtime-config.ts";
import {
  rowPreview,
  type BindingModel,
  type BindingRow,
  type BindingWorkbench,
  type GrantOption,
  type GrantProblem,
  type RowStatus,
  type ToolEvaluation,
} from "../../../agents/tool-bindings.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import { type BadgeColor } from "../../../status.ts";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import { ResourceLink } from "../../resource-link.tsx";
import { StatusBadge } from "@/components/status-badge";

const UNBOUND = "";

const STATUS: Record<RowStatus["kind"], { readonly color: BadgeColor; readonly label: string }> = {
  binding_ignored: { color: "zinc", label: "Binding unused" },
  canary_conflict: { color: "red", label: "Finish the canary first" },
  grant_unusable: { color: "amber", label: "Runtime would deny" },
  needs_grant: { color: "red", label: "Grant required" },
  not_bindable_in_canary: {
    color: "zinc",
    label: "Not bindable during canary",
  },
  optional_unbound: { color: "zinc", label: "Optional" },
  policy_unusable: { color: "amber", label: "Policy inactive" },
  ready: { color: "green", label: "Ready" },
  unregistered: { color: "amber", label: "Tool not registered" },
};

function grantProblemText(problem: GrantProblem) {
  switch (problem.kind) {
    case "missing":
      return "The pinned grant no longer exists.";
    case "revoked":
      return "The pinned grant is revoked.";
    case "wrong_purpose":
      return "The grant is not for agent runtime use.";
    case "wrong_provider":
      return `The tool runs through ${problem.expected}; this grant is for another provider.`;
    case "wrong_server":
      return "The grant is for a different MCP server than the tool's.";
    case "mcp_connection_inactive":
      return "The grant's MCP connection is not active.";
    case "missing_scopes":
      return `The grant lacks ${problem.scopes.join(", ")}.`;
    default: {
      const unexpected: never = problem;
      return unexpected;
    }
  }
}

function statusDetail(status: RowStatus) {
  switch (status.kind) {
    case "grant_unusable":
      return grantProblemText(status.problem);
    case "canary_conflict":
      return "One release requires this tool and the other cannot bind it.";
    case "binding_ignored":
      return "The runtime decides this tool without a grant.";
    case "policy_unusable":
      return "The pinned policy is archived or gone, so the runtime denies the tool.";
    case "unregistered":
      return "No active tool has this name, so the runtime denies it.";
    default:
      return undefined;
  }
}

function grantLabel(grant: GrantOption) {
  const workspace =
    grant.workspaceId === null
      ? "all workspaces"
      : (grant.workspaceName ?? `workspace …${grant.workspaceId.slice(-8)}`);
  return `${grant.providerKey} · ${workspace} · …${grant.id.slice(-8)}`;
}

function Decision({
  evaluations,
  policyName,
  row,
  scope,
}: Readonly<{
  evaluations: ReadonlyMap<string, ToolEvaluation>;
  policyName: ReadonlyMap<string, string>;
  row: BindingRow;
  scope: EnvironmentScope;
}>) {
  const preview = rowPreview(row, evaluations);
  switch (preview.kind) {
    case "policy":
      return (
        <>
          <StatusBadge status={preview.evaluation.action} />
          <span className="text-xs/5 text-muted-foreground">{preview.evaluation.reason}</span>
          <span className="text-xs/5">
            <ResourceLink
              scope={scope}
              to={{ kind: "toolPolicy", toolPolicyId: preview.toolPolicyId }}
            >
              {policyName.get(preview.toolPolicyId) ?? `Policy …${preview.toolPolicyId.slice(-8)}`}
            </ResourceLink>
          </span>
        </>
      );
    case "tool_default":
      return (
        <>
          <StatusBadge status={preview.action} />
          <span className="text-xs/5 text-muted-foreground">Tool default, no policy pinned</span>
        </>
      );
    case "pending":
      return <span className="text-xs/5 text-muted-foreground">Evaluating…</span>;
    case "not_applicable":
      return null;
    default: {
      const unexpected: never = preview;
      return unexpected;
    }
  }
}

/**
 * One row per tool a target release declares with workspace authorization: the grant and policy
 * it pins, whether the API and the runtime would accept that, and the decision it previews.
 */
export function BindingsTable({
  evaluations,
  model,
  onChoose,
  readOnly,
  scope,
  workbench,
}: Readonly<{
  evaluations: ReadonlyMap<string, ToolEvaluation>;
  model: BindingModel;
  onChoose: (tool: string, binding: ToolBinding | null) => void;
  readOnly: boolean;
  scope: EnvironmentScope;
  workbench: BindingWorkbench;
}>) {
  const policyName = new Map(workbench.policies.items.map(({ id, name }) => [id, name]));
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Grant</TableHead>
          <TableHead>Tool policy and decision</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {model.rows.map((row) => {
          const { after, eligible, status, tool } = row;
          const pinned = workbench.grants.find(({ id }) => id === after?.authorizationId);
          const grants = pinned && !eligible.includes(pinned) ? [pinned, ...eligible] : eligible;
          const locked =
            readOnly ||
            status.kind === "canary_conflict" ||
            status.kind === "not_bindable_in_canary";
          const detail = statusDetail(status);
          return (
            <TableRow key={tool.name}>
              <TableCell>
                <div className="flex max-w-48 flex-col items-start gap-1 whitespace-normal">
                  <Code>{tool.name}</Code>
                  <span className="text-xs/5 text-muted-foreground">
                    {tool.requiredIn.length > 0 ? "Required" : "Optional"}
                    {tool.requiredScopes.length > 0
                      ? ` · needs ${tool.requiredScopes.join(", ")}`
                      : ""}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <NativeSelect
                  aria-label={`Grant for ${tool.name}`}
                  className="min-w-48"
                  disabled={locked}
                  name={`grant-${tool.name}`}
                  onChange={(event) =>
                    onChoose(
                      tool.name,
                      event.target.value === UNBOUND
                        ? null
                        : {
                            authorizationId: event.target.value,
                            ...(after?.toolPolicyId ? { toolPolicyId: after.toolPolicyId } : {}),
                          },
                    )
                  }
                  value={after?.authorizationId ?? UNBOUND}
                >
                  <option value={UNBOUND}>Unbound</option>
                  {after && !pinned ? (
                    <option value={after.authorizationId}>
                      Missing grant …{after.authorizationId.slice(-8)}
                    </option>
                  ) : null}
                  {grants.map((grant) => (
                    <option key={grant.id} value={grant.id}>
                      {grantLabel(grant)}
                      {eligible.includes(grant) ? "" : " (unusable)"}
                    </option>
                  ))}
                </NativeSelect>
              </TableCell>
              <TableCell>
                <div className="flex w-52 flex-col items-start gap-1 whitespace-normal">
                  <NativeSelect
                    aria-label={`Tool policy for ${tool.name}`}
                    className="w-full"
                    disabled={locked || !after}
                    name={`policy-${tool.name}`}
                    onChange={(event) =>
                      after &&
                      onChoose(tool.name, {
                        authorizationId: after.authorizationId,
                        ...(event.target.value === UNBOUND
                          ? {}
                          : { toolPolicyId: event.target.value }),
                      })
                    }
                    value={after?.toolPolicyId ?? UNBOUND}
                  >
                    <option value={UNBOUND}>No policy</option>
                    {after?.toolPolicyId && !policyName.has(after.toolPolicyId) ? (
                      <option value={after.toolPolicyId}>
                        {workbench.policies.complete ? "Inactive" : "Unlisted"} …
                        {after.toolPolicyId.slice(-8)}
                      </option>
                    ) : null}
                    {workbench.policies.items.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Decision
                    evaluations={evaluations}
                    policyName={policyName}
                    row={row}
                    scope={scope}
                  />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex max-w-52 flex-col items-start gap-1 whitespace-normal">
                  <Badge color={STATUS[status.kind].color}>{STATUS[status.kind].label}</Badge>
                  {detail ? (
                    <span className="text-xs/5 text-muted-foreground">{detail}</span>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
