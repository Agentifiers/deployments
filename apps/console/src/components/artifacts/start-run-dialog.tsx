import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { startRunWithInputFn } from "../../data/artifact-mutations.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { invalidateRuntime, threadQuery } from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Description, Field, Label } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Text } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";

const DEFAULT_MESSAGE = "Read the attached file and summarize it.";

/**
 * Starts a run on the input file's thread, on the deployment that thread belongs to. The API
 * checks the rest: the file is a private `input` upload by the caller, in this thread.
 */
export function StartRunDialog({
  artifactId,
  onClose,
  open,
  scope,
  threadId,
}: Readonly<{
  artifactId: string;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
  threadId: string;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: thread } = useQuery({ ...threadQuery(scope, threadId), enabled: open });
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const held = useKeyedSnapshot<string>();
  const deploymentId = thread?.agentDeploymentId;
  const content = message.trim();
  return (
    <ActionDialog
      confirmLabel="Start run"
      description="The run reads the file as input. It runs on the thread the file was uploaded to."
      invalid={deploymentId === undefined || content === ""}
      onClose={onClose}
      onSuccess={(started: { readonly runId: string }) => {
        void invalidateRuntime(queryClient, scope);
        void navigate({ to: `${environmentPath(scope)}/runs/${started.runId}` });
      }}
      open={open}
      run={(idempotencyKey, resend) => {
        if (deploymentId === undefined) throw new TypeError("The thread has no deployment.");
        return startRunWithInputFn({
          data: {
            agentDeploymentId: deploymentId,
            artifactId,
            content: held(idempotencyKey, resend, content),
            idempotencyKey,
            scope,
            threadId,
          },
        });
      }}
      successMessage="Run started"
      title="Start a run with this file"
    >
      <Text>
        {deploymentId
          ? `Deployment: ${agentLabels(directory).deployment(deploymentId)}`
          : thread
            ? "This thread belongs to no deployment, so no run can start on it."
            : "Reading the thread…"}
      </Text>
      <Field>
        <Label>Message</Label>
        <Description>What the agent should do with the file.</Description>
        <Textarea
          name="message"
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          value={message}
        />
      </Field>
    </ActionDialog>
  );
}
