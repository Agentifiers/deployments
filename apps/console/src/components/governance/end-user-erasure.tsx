import { UserRemove01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { eraseEndUserFn } from "../../data/thread-mutations.ts";
import { ERASE_END_USER_PHRASE } from "../../runs/erasure-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ConversationErasure } from "../../server/thread-data.ts";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

const MAX_END_USER_ID_LENGTH = 256;

const ERASE_EFFECTS =
  "Every thread the end user started in this environment is erased with its runs, messages, files, memories, and traces. Active runs are canceled. It cannot be undone.";

/**
 * Honors one end user's deletion request. The end-user ID is the one your product sent with their
 * messages; the platform keeps only a keyed pseudonym of it, so it cannot list end users.
 */
export function EndUserErasureSection({ organizationId }: Readonly<{ organizationId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(organizationId));
  const navigate = useNavigate();
  const environments = shell.projects.flatMap(({ environments: list, project }) =>
    list
      .filter((environment) => environment.status === "active")
      .map((environment) => ({
        label: `${project.name} / ${environment.name}`,
        scope: { environmentId: environment.id, organizationId, projectId: project.id },
      })),
  );
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState(environments[0]?.scope.environmentId ?? "");
  const [endUserId, setEndUserId] = useState("");
  const scope: EnvironmentScope | undefined = environments.find(
    (entry) => entry.scope.environmentId === environmentId,
  )?.scope;
  const trimmed = endUserId.trim();
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Erase an end user</Subheading>
      <Text>
        When one of your end users asks to be forgotten, erase their conversations here. Enter the
        end-user ID your product sent with their messages.
      </Text>
      <div>
        <Button
          disabled={environments.length === 0}
          onClick={() => setOpen(true)}
          variant="destructive"
        >
          <Icon icon={UserRemove01Icon} />
          Erase an end user
        </Button>
      </div>
      <ActionDialog
        confirmLabel="Erase end user"
        confirmation={ERASE_END_USER_PHRASE}
        description={ERASE_EFFECTS}
        destructive
        invalid={scope === undefined || trimmed === "" || trimmed.length > MAX_END_USER_ID_LENGTH}
        onClose={() => setOpen(false)}
        onSuccess={(erasure: ConversationErasure) => {
          if (!scope) return;
          void navigate({
            params: {
              envId: scope.environmentId,
              erasureId: erasure.id,
              orgId: organizationId,
              projectId: scope.projectId,
            },
            to: "/o/$orgId/p/$projectId/e/$envId/end-user-erasures/$erasureId",
          });
        }}
        open={open}
        runOnce={() => {
          if (!scope) throw new TypeError("Choose an environment.");
          return eraseEndUserFn({ data: { endUserId: trimmed, scope } });
        }}
        successMessage="Erasure started"
        title="Erase an end user?"
      >
        <Field>
          <Label>Environment</Label>
          <NativeSelect
            name="environmentId"
            onChange={(event) => setEnvironmentId(event.target.value)}
            value={environmentId}
          >
            {environments.map((entry) => (
              <option key={entry.scope.environmentId} value={entry.scope.environmentId}>
                {entry.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <Label>End-user ID</Label>
          <Input
            autoComplete="off"
            maxLength={MAX_END_USER_ID_LENGTH}
            name="endUserId"
            onChange={(event) => setEndUserId(event.target.value)}
            value={endUserId}
          />
          <Description>
            The <Code>endUserId</Code> your product sent with the end user&apos;s messages. The
            platform stores only a keyed pseudonym of it.
          </Description>
        </Field>
      </ActionDialog>
    </section>
  );
}
