import { Archive02Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import { archiveThreadFn, eraseThreadFn } from "../../data/thread-mutations.ts";
import { ERASE_THREAD_PHRASE } from "../../runs/erasure-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { Thread } from "../../server/runtime-data.ts";
import type { ConversationErasure } from "../../server/thread-data.ts";
import { Button } from "@/components/ui/button";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";

const ERASE_EFFECTS =
  "Erasing deletes the thread, its runs, messages, files, memories it produced, its live stream, and its traces. Runs must be finished or canceled first. It cannot be undone.";

/**
 * Archive hides a customer thread from new activity and keeps its history; erase deletes it, for
 * example to honor a deletion request. Preview and evaluation threads follow their binding.
 */
export function ThreadActions({
  scope,
  thread,
}: Readonly<{ scope: EnvironmentScope; thread: Thread }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [dialog, setDialog] = useState<"archive" | "erase">();
  if (thread.executionPurpose !== "customer") return null;
  const canArchive = shell.access.archiveThread && !thread.archived;
  const canErase = shell.access.eraseThread;
  if (!canArchive && !canErase) return null;
  const refresh = () => invalidateRuntime(queryClient, scope);
  return (
    <div className="ml-auto flex gap-3">
      {canArchive ? (
        <Button onClick={() => setDialog("archive")} variant="outline">
          <Icon icon={Archive02Icon} />
          Archive
        </Button>
      ) : null}
      {canErase ? (
        <Button onClick={() => setDialog("erase")} variant="destructive">
          <Icon icon={Delete02Icon} />
          Erase
        </Button>
      ) : null}
      <ActionDialog
        confirmLabel="Archive thread"
        description="The thread keeps its transcript, runs, and files, and accepts no new messages. Threads with active runs cannot be archived."
        onClose={() => setDialog(undefined)}
        onSuccess={() => void refresh()}
        open={dialog === "archive"}
        runOnce={() =>
          refreshOnConflict(archiveThreadFn({ data: { scope, threadId: thread.id } }), refresh)
        }
        successMessage="Thread archived"
        title="Archive this thread?"
      />
      <ActionDialog
        confirmLabel="Erase thread"
        confirmation={ERASE_THREAD_PHRASE}
        description={ERASE_EFFECTS}
        destructive
        onClose={() => setDialog(undefined)}
        onSuccess={(erasure: ConversationErasure) =>
          void navigate({
            params: {
              envId: scope.environmentId,
              erasureId: erasure.id,
              orgId: scope.organizationId,
              projectId: scope.projectId,
              threadId: thread.id,
            },
            to: "/o/$orgId/p/$projectId/e/$envId/threads/$threadId/erasures/$erasureId",
          })
        }
        open={dialog === "erase"}
        runOnce={() =>
          refreshOnConflict(eraseThreadFn({ data: { scope, threadId: thread.id } }), refresh)
        }
        successMessage="Erasure started"
        title="Erase this thread?"
      />
    </div>
  );
}
