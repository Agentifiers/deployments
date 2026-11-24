import type { ReactNode } from "react";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { PinningDeployment, PolicyPinning } from "../../tool-policies/policy-state.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { PublicId } from "../public-id.tsx";

export function PinnedByTable({
  pinning,
  scope,
}: Readonly<{ pinning: readonly PinningDeployment[]; scope: EnvironmentScope }>) {
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Deployment</TableHead>
          <TableHead>Tools</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pinning.map((deployment) => (
          <TableRow key={deployment.deploymentId}>
            <TableCell>
              <TextLink
                href={`${environmentPath(scope)}/agents/${deployment.agentDefinitionId}/deployments`}
              >
                {deployment.agentName ?? deployment.agentDefinitionId}
              </TextLink>
            </TableCell>
            <TableCell>
              <PublicId value={deployment.deploymentId} />
            </TableCell>
            <TableCell className="whitespace-normal">
              {deployment.tools.map((tool, index) => (
                <span key={tool}>
                  {index === 0 ? null : ", "}
                  <Code>{tool}</Code>
                </span>
              ))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PinningNotice({
  children,
  pinning,
  scope,
}: Readonly<{ children: ReactNode; pinning: PolicyPinning; scope: EnvironmentScope }>) {
  if (pinning.pinning.length > 0) {
    return (
      <>
        <Text>{children}</Text>
        <PinnedByTable pinning={pinning.pinning} scope={scope} />
        {pinning.known ? null : (
          <Text>
            The console could not read every deployment, so other live deployments may pin this
            policy too.
          </Text>
        )}
      </>
    );
  }
  return (
    <Text>
      {pinning.known
        ? "No live deployment pins this policy."
        : "The console could not read every deployment, so a live deployment may pin this policy."}
    </Text>
  );
}
