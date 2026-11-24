import { useMemo, useState } from "react";
import { checkDraft, draftText } from "../../agents/manifest-draft.ts";
import { updateAgentDefinitionFn } from "../../data/agent-mutations.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { AgentDetail } from "../../server/agent-data.ts";
import type { EnvironmentSummary } from "../../server/console-data.ts";
import type { AgentManifestV1 } from "@deployments-ai/agent-manifest/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { ManifestDiffView } from "./manifest-diff-view.tsx";
import { ManifestEditor } from "./manifest-editor.tsx";

/** The editor's text and the definition version it was loaded from, which a save must match. */
interface Edit {
  readonly loaded: string;
  readonly text: string;
  readonly version: number;
}

function loadedEdit(definition: AgentDetail["definition"]): Edit {
  const text = draftText(definition.draft);
  return { loaded: text, text, version: definition.version };
}

/**
 * Edits the definition's draft manifest. A save sends the whole manifest with the version the
 * editor loaded, so a draft saved elsewhere in the meantime is refused instead of overwritten.
 * When a newer version arrives, a clean editor takes it; an editor with changes keeps them and
 * offers to reload.
 */
export function DraftEditor({
  agent,
  environment,
  onRefresh,
  scope,
}: Readonly<{
  agent: AgentDetail;
  environment: EnvironmentSummary;
  onRefresh: () => Promise<unknown>;
  scope: EnvironmentScope;
}>) {
  const { definition } = agent;
  const [edit, setEdit] = useState(() => loadedEdit(definition));
  const [saving, setSaving] = useState(false);
  const snapshot = useKeyedSnapshot<{ manifest: AgentManifestV1; version: number }>();
  const check = useMemo(() => checkDraft(edit.text), [edit.text]);
  const changed = edit.text !== edit.loaded;
  // Versions only grow; after a save the editor runs ahead of the agent read until it refetches.
  const stale = definition.version > edit.version;
  if (stale && !changed) setEdit(loadedEdit(definition));
  const reload = () => {
    setSaving(false);
    setEdit(loadedEdit(definition));
    void onRefresh();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Text>Draft {edit.version}</Text>
        {changed ? <Badge color="amber">unsaved changes</Badge> : null}
        <div className="ml-auto flex gap-2">
          {changed ? (
            <Button
              onClick={() => setEdit((current) => ({ ...current, text: current.loaded }))}
              variant="ghost"
            >
              Discard changes
            </Button>
          ) : null}
          <Button disabled={!changed || check.kind !== "valid"} onClick={() => setSaving(true)}>
            Save draft
          </Button>
        </div>
      </div>
      {stale && changed ? (
        <Callout variant="warning">
          <CalloutTitle>Draft {definition.version} was saved while you edited</CalloutTitle>
          <CalloutDescription>
            <p>
              Saving your changes would be refused because they start from draft {edit.version}.
              Reload to edit draft {definition.version}; your changes are discarded.
            </p>
            <Button className="mt-2" onClick={reload} size="sm" variant="outline">
              Reload the draft
            </Button>
          </CalloutDescription>
        </Callout>
      ) : null}
      <ManifestEditor
        check={check}
        onText={(text) => setEdit((current) => ({ ...current, text }))}
        text={edit.text}
      />
      <ActionDialog
        confirmLabel="Save draft"
        confirmation={typedConfirmation(environment.type, { phrase: definition.slug })}
        description={`Replaces draft ${edit.version}. Running deployments are unchanged until you publish a release and deploy it.`}
        invalid={check.kind !== "valid"}
        onClose={() => setSaving(false)}
        onSuccess={(saved: AgentDetail["definition"]) => {
          setEdit(loadedEdit(saved));
          void onRefresh();
        }}
        open={saving}
        problemAction={(problem) =>
          problem.status === 409 ? (
            <>
              <p>
                The draft changed after you loaded it, or the agent was archived. Reload the draft
                to continue from the latest version; your changes are discarded.
              </p>
              <Button className="mt-2" onClick={reload} size="sm" variant="outline">
                Reload the draft
              </Button>
            </>
          ) : null
        }
        run={(idempotencyKey, resend) => {
          if (check.kind !== "valid") throw new Error("The manifest is invalid.");
          const body = snapshot(idempotencyKey, resend, {
            manifest: check.manifest,
            version: edit.version,
          });
          return updateAgentDefinitionFn({
            data: {
              body: { expectedVersion: body.version, manifest: body.manifest },
              definitionId: definition.id,
              idempotencyKey,
              scope,
            },
          });
        }}
        size="3xl"
        successMessage="Draft saved"
        title="Save the draft"
      >
        {check.kind === "valid" ? (
          <ManifestDiffView
            baseline={JSON.parse(edit.loaded)}
            baselineLabel={`version ${edit.version}`}
            candidate={check.manifest}
            candidateLabel="your changes"
          />
        ) : null}
      </ActionDialog>
    </div>
  );
}
