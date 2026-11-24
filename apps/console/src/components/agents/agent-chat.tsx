import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  createChatThreadFn,
  createDraftPreviewFn,
  deletePreviewFn,
  submitChatTurnFn,
  submitPreviewTurnFn,
} from "../../data/chat-mutations.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDeployment, AgentDetail } from "../../server/agent-data.ts";
import type { DraftPreview } from "../../server/chat-actions.ts";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/status";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ChatPanel, type ChatTarget } from "../runs/chat-panel.tsx";
import { liveDeployments, releaseLabel } from "./agent-header.tsx";

function scopeOf(agent: AgentDetail): EnvironmentScope {
  const { environmentId, organizationId, projectId } = agent.definition;
  return { environmentId, organizationId, projectId };
}

/** Chat with one deployment: each conversation is a new thread, each message a run on it. */
export function DeploymentChat({
  agent,
  deployment,
}: Readonly<{ agent: AgentDetail; deployment: AgentDeployment }>) {
  const scope = scopeOf(agent);
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const target: ChatTarget = {
    async submit(attempt, threadId, onThreadOpened) {
      let thread = threadId;
      if (thread === undefined) {
        thread = await createChatThreadFn({
          data: { agentDeploymentId: deployment.id, scope },
        });
        onThreadOpened(thread);
      }
      return submitChatTurnFn({
        data: {
          agentDeploymentId: deployment.id,
          content: attempt.content,
          idempotencyKey: attempt.idempotencyKey,
          scope,
          threadId: thread,
        },
      });
    },
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Text>Chatting with deployment</Text>
        <PublicId value={deployment.id} />
        <Badge color={deployment.currentState === "ready" ? "green" : "amber"}>
          {statusLabel(deployment.currentState)}
        </Badge>
        <Text>running {releaseLabel(agent, deployment.agentReleaseId)}</Text>
      </div>
      {deployment.currentState === "ready" ? null : (
        <Callout variant="warning">
          <CalloutTitle>
            This deployment is {statusLabel(deployment.currentState).toLowerCase()}
          </CalloutTitle>
          <CalloutDescription>Runs may wait or fail until it is ready.</CalloutDescription>
        </Callout>
      )}
      <ChatPanel
        access={access}
        key={deployment.id}
        resetLabel="New conversation"
        scope={scope}
        target={target}
      />
    </div>
  );
}

/** No deployment to borrow tool bindings from: the preview runs with the default configuration. */
const NO_BINDINGS = "";

/**
 * Previews the draft. The preview is created on the first message and deleted on reset and when
 * the page goes away; it snapshots the draft, so a reset picks up later draft edits.
 */
export function DraftPlayground({ agent }: Readonly<{ agent: AgentDetail }>) {
  const scope = scopeOf(agent);
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const live = liveDeployments(agent);
  const [bindingsFrom, setBindingsFrom] = useState(live[0]?.id ?? NO_BINDINGS);
  const [preview, setPreview] = useState<DraftPreview>();
  // The page may go away mid-request; the ref sees the preview the latest render holds.
  const current = useRef<DraftPreview>(undefined);
  current.current = preview;

  const discard = () => {
    const previewId = current.current?.id;
    current.current = undefined;
    setPreview(undefined);
    if (previewId) void deletePreviewFn({ data: { previewId, scope } }).catch(() => undefined);
  };
  // Leaving the page deletes the preview; it would otherwise expire on its own after an hour.
  const leave = useRef(discard);
  leave.current = discard;
  useEffect(() => () => leave.current(), []);

  const target: ChatTarget = {
    async submit(attempt, threadId, onThreadOpened) {
      let active = current.current;
      if (active === undefined) {
        active = await createDraftPreviewFn({
          data: {
            definitionId: agent.definition.id,
            // The preview key derives from the message key, so a resent message reuses one preview.
            idempotencyKey: `preview:${attempt.idempotencyKey}`,
            scope,
            ...(bindingsFrom === NO_BINDINGS ? {} : { fromAgentDeploymentId: bindingsFrom }),
          },
        });
        current.current = active;
        setPreview(active);
      }
      const turn = await submitPreviewTurnFn({
        data: {
          content: attempt.content,
          idempotencyKey: attempt.idempotencyKey,
          previewId: active.id,
          scope,
          ...(threadId === undefined ? {} : { threadId }),
        },
      });
      if (threadId === undefined) onThreadOpened(turn.threadId);
      return turn;
    },
  };

  return (
    <div className="flex flex-col gap-6">
      <Callout>
        <CalloutTitle>This runs the unpublished draft</CalloutTitle>
        <CalloutDescription>
          The playground previews draft {agent.definition.version}, not a release. Preview runs do
          not write memory, reach webhooks or channels, or delegate to other agents.
        </CalloutDescription>
      </Callout>
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-96" disabled={preview !== undefined}>
          <Label>Tool bindings from</Label>
          <NativeSelect
            onChange={(event) => setBindingsFrom(event.target.value)}
            value={bindingsFrom}
          >
            {live.map((deployment) => (
              <option key={deployment.id} value={deployment.id}>
                Deployment …{deployment.id.slice(-8)} (
                {releaseLabel(agent, deployment.agentReleaseId)})
              </option>
            ))}
            <option value={NO_BINDINGS}>None (tools that need a grant are unavailable)</option>
          </NativeSelect>
          <Description>
            The preview copies this deployment's tool bindings when it starts.
          </Description>
        </Field>
        {preview ? (
          <Text className="flex-1">
            Preview <PublicId value={preview.id} /> of draft {preview.draftVersion} expires{" "}
            <Timestamp value={preview.expiresAt} />.
          </Text>
        ) : null}
      </div>
      <ChatPanel
        access={access}
        onReset={discard}
        resetLabel="Reset preview"
        scope={scope}
        target={target}
      />
    </div>
  );
}
