import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { environmentQuery } from "../../../data/console-queries.ts";
import {
  createDraftFn,
  respondToMessageFn,
  sendMessageFn,
  updateDraftFn,
} from "../../../data/agent-email-mailbox-mutations.ts";
import { composeContextQuery } from "../../../data/agent-email-mailbox-queries.ts";
import { invalidateAgentEmail } from "../../../data/agent-email-setup-queries.ts";
import {
  COMPOSE_SHAPES,
  classifyRecipients,
  composeContext,
  composeFields,
  readCompose,
  replyRecipients,
  sendConfirmation,
  type AttachmentInput,
  type ComposeBody,
  type ComposeMode,
  type RecipientClass,
} from "../../../email/compose-state.ts";
import { UnauthenticatedError } from "../../../errors.ts";
import type { AgentEmailInbox } from "../../../email/inbox-state.ts";
import { POLICY_LIMITS } from "../../../email/policy-state.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog } from "../../action-dialog.tsx";
import { beforeToday, DateTimePicker } from "../../date-picker.tsx";
import { fileBase64 } from "../../file-base64.ts";
import { describeProblem, ProblemReference } from "../../section-boundary.tsx";

const RECIPIENT_BADGES: Readonly<
  Record<RecipientClass, { readonly color: "green" | "sky" | "amber"; readonly label: string }>
> = {
  allowlisted: { color: "sky", label: "allowlisted, outside this environment" },
  environment_inbox: { color: "green", label: "inbox in this environment" },
  external: { color: "amber", label: "outside this environment" },
};

const TITLES: Readonly<Record<ComposeMode["kind"], string>> = {
  draft: "Draft",
  forward: "Forward",
  reply: "Reply",
  send: "Send message",
};

async function encodeAttachment(file: File): Promise<AttachmentInput> {
  return {
    contentBase64: await fileBase64(file),
    contentType: file.type || "application/octet-stream",
    fileName: file.name,
  };
}

type Composed =
  | { readonly kind: "draft"; readonly id: string }
  | { readonly kind: "message"; readonly id: string };

async function submitCompose(
  mode: ComposeMode,
  inbox: AgentEmailInbox,
  scope: EnvironmentScope,
  body: ComposeBody,
  idempotencyKey: string,
): Promise<Composed> {
  switch (mode.kind) {
    case "send": {
      const message = await sendMessageFn({
        data: { body, idempotencyKey, inboxId: inbox.id, scope },
      });
      return { id: message.id, kind: "message" };
    }
    case "reply":
    case "forward": {
      const message = await respondToMessageFn({
        data: {
          body,
          idempotencyKey,
          messageId: mode.message.id,
          mode: mode.kind === "forward" ? "forward" : mode.all ? "replyAll" : "reply",
          scope,
        },
      });
      return { id: message.id, kind: "message" };
    }
    case "draft": {
      const draft = mode.draft
        ? await updateDraftFn({ data: { body, draftId: mode.draft.id, idempotencyKey, scope } })
        : await createDraftFn({ data: { body, idempotencyKey, inboxId: inbox.id, scope } });
      return { id: draft.id, kind: "draft" };
    }
  }
}

export function RecipientList({
  classes,
  complete,
}: Readonly<{ classes: ReadonlyMap<string, RecipientClass>; complete: boolean }>) {
  if (classes.size === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {[...classes].map(([address, recipientClass]) => (
          <li className="flex flex-wrap items-center gap-2 text-sm/6" key={address}>
            <span className="font-mono">{address}</span>
            <Badge color={RECIPIENT_BADGES[recipientClass].color}>
              {RECIPIENT_BADGES[recipientClass].label}
            </Badge>
          </li>
        ))}
      </ul>
      {complete ? null : (
        <Text>
          This environment has more inboxes than the console reads, so some of its own inboxes may
          be marked as outside it.
        </Text>
      )}
    </div>
  );
}

export function RecipientReadProblem({ error, title }: Readonly<{ error: Error; title: string }>) {
  if (error instanceof UnauthenticatedError) throw error;
  const problem = describeProblem(error, title);
  return (
    <Callout variant="destructive">
      <CalloutTitle>{problem.title}</CalloutTitle>
      <CalloutDescription>
        {problem.description ? <p>{problem.description}</p> : null}
        <p>Close the dialog and try again.</p>
        <ProblemReference requestId={problem.requestId} status={problem.status} />
      </CalloutDescription>
    </Callout>
  );
}

export function ComposeDialog({
  inbox,
  mode,
  onClose,
  scope,
}: Readonly<{
  inbox: AgentEmailInbox;
  mode: ComposeMode;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const context = composeContext(useQuery(composeContextQuery(scope, inbox.id)));
  const ready = context.kind === "ready" ? context.context : undefined;
  const [fields, setFields] = useState(() => composeFields(mode));
  const [files, setFiles] = useState<readonly File[]>([]);

  const shape = COMPOSE_SHAPES[mode.kind];
  const read = readCompose(mode, fields, {
    attachments: files,
    inboxAddress: inbox.address,
    now: new Date(),
    policyMaxAttachmentBytes: ready?.maxAttachmentBytes ?? POLICY_LIMITS.maxAttachmentBytes.max,
  });
  const classes = classifyRecipients(
    read.ok ? read.recipients : [],
    new Set(ready?.ownInboxes ?? []),
    ready?.allowlist ?? [],
  );
  const sendsMail = mode.kind !== "draft";
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch });

  return (
    <ActionDialog<Composed>
      confirmLabel={sendsMail ? (fields.scheduledAt ? "Schedule" : "Send") : "Save draft"}
      confirmation={sendsMail && ready ? sendConfirmation(classes, environment.type) : undefined}
      description={
        sendsMail
          ? `Sends from ${inbox.address}. Recipients outside this environment receive real mail.`
          : `Saves a draft in ${inbox.address}. It sends only after it is submitted, approved, and sent.`
      }
      invalid={!read.ok || (sendsMail && ready === undefined)}
      onClose={onClose}
      onSuccess={(composed) => {
        void invalidateAgentEmail(queryClient, scope);
        const params = {
          envId: scope.environmentId,
          orgId: scope.organizationId,
          projectId: scope.projectId,
        };
        void navigate(
          composed.kind === "draft"
            ? {
                params: { ...params, draftId: composed.id },
                to: "/o/$orgId/p/$projectId/e/$envId/email/drafts/$draftId",
              }
            : {
                params: { ...params, messageId: composed.id },
                to: "/o/$orgId/p/$projectId/e/$envId/email/messages/$messageId",
              },
        );
      }}
      open
      retryNotice={
        sendsMail
          ? "Submitting again resends this request with the same key, so the message goes out at most once."
          : "The platform may have saved this draft. Choose Save draft to finish saving it under the same key, which opens the saved draft. Leave unfinished discards what you typed here."
      }
      run={async (idempotencyKey) => {
        if (!read.ok) throw new Error(read.message);
        const attachments = shape.attachments ? await Promise.all(files.map(encodeAttachment)) : [];
        return submitCompose(
          mode,
          inbox,
          scope,
          attachments.length > 0 ? { ...read.body, attachments } : read.body,
          idempotencyKey,
        );
      }}
      size="2xl"
      successMessage={(composed) =>
        composed.kind === "draft"
          ? "Draft saved"
          : fields.scheduledAt
            ? "Message scheduled"
            : "Message queued"
      }
      title={
        mode.kind === "reply" && mode.all
          ? "Reply all"
          : `${TITLES[mode.kind]} from ${inbox.address}`
      }
    >
      {shape.to === "typed" ? (
        <Field>
          <Label>To</Label>
          <Input
            autoComplete="off"
            onChange={(event) => set({ to: event.target.value })}
            value={fields.to}
          />
        </Field>
      ) : (
        <Text>
          To:{" "}
          {mode.kind === "reply"
            ? replyRecipients(mode.message, inbox.address, mode.all).join(", ")
            : ""}
        </Text>
      )}
      <Field>
        <Label>Cc</Label>
        <Input
          autoComplete="off"
          onChange={(event) => set({ cc: event.target.value })}
          value={fields.cc}
        />
      </Field>
      <Field>
        <Label>Bcc</Label>
        <Input
          autoComplete="off"
          onChange={(event) => set({ bcc: event.target.value })}
          value={fields.bcc}
        />
      </Field>
      {shape.subject ? (
        <Field>
          <Label>Subject</Label>
          <Input
            onChange={(event) => set({ subject: event.target.value })}
            value={fields.subject}
          />
        </Field>
      ) : null}
      <Field>
        <Label>Message</Label>
        {mode.kind === "draft" && mode.draft?.htmlBody !== undefined ? (
          <Description>
            This draft also has an HTML part, which saving keeps unchanged. Mail clients that show
            HTML display that part, not this text.
          </Description>
        ) : null}
        <Textarea
          onChange={(event) => set({ text: event.target.value })}
          rows={8}
          value={fields.text}
        />
      </Field>
      {shape.includeOriginal ? (
        <CheckboxField>
          <Checkbox
            checked={fields.includeOriginal}
            onCheckedChange={(includeOriginal) => set({ includeOriginal })}
          />
          <Label>Include the original message</Label>
        </CheckboxField>
      ) : null}
      {shape.attachments ? (
        <Field>
          <Label>Attachments</Label>
          <FileInput multiple onChange={setFiles} value={files} />
        </Field>
      ) : null}
      <Field>
        <Label>Send at</Label>
        <Description>
          {sendsMail
            ? "Leave blank to send now. A scheduled message cannot be canceled; schedule a draft to keep that option."
            : "Leave blank to send as soon as the approved draft is sent. Once saved, a send time can be moved but not removed."}
        </Description>
        <DateTimePicker
          disabledDays={beforeToday()}
          label="Send at"
          onChange={(scheduledAt) => set({ scheduledAt })}
          value={fields.scheduledAt}
        />
      </Field>
      {context.kind === "failed" ? (
        sendsMail ? (
          <RecipientReadProblem
            error={context.error}
            title="This environment's inboxes and allowlist could not be read"
          />
        ) : (
          <Text>
            The recipients could not be classified, because this environment&apos;s inboxes and
            allowlist could not be read. Saving the draft still works.
          </Text>
        )
      ) : context.kind === "reading" ? (
        <Text>Reading this environment&apos;s inboxes and allowlist…</Text>
      ) : (
        <RecipientList classes={classes} complete={context.context.complete} />
      )}
      {read.ok ? null : <Text>{read.message}</Text>}
    </ActionDialog>
  );
}
