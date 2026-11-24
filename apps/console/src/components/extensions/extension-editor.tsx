import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { createExtensionFn, updateExtensionFn } from "../../data/extension-mutations.ts";
import { extensionQuery, invalidateExtensions } from "../../data/extension-queries.ts";
import {
  blankDraft,
  createWrite,
  editDraft,
  rebaseDraft,
  updateWrite,
  type ExtensionDraft,
  type ExtensionTool,
} from "../../extensions/extension-draft.ts";
import {
  KIND_LABELS,
  type ExtensionLocator,
  type NewExtensionSearch,
} from "../../extensions/extension-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Code, Text, TextLink } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { AbsentExtension } from "./extension-detail.tsx";
import { ExtensionFields } from "./extension-form.tsx";

const RETRY_NOTICE =
  "Submit again to finish. The retry reuses this request's keys, so it uploads and saves at most once.";

/** The name rides along so the detail resolves even past the capped directory. */
function useOpenDetail(scope: EnvironmentScope) {
  const navigate = useNavigate();
  return ({ id, name }: Pick<ExtensionTool, "id" | "name">) =>
    void navigate({
      params: {
        envId: scope.environmentId,
        extensionId: id,
        orgId: scope.organizationId,
        projectId: scope.projectId,
      },
      search: { name },
      to: "/o/$orgId/p/$projectId/e/$envId/extensions/$extensionId",
    });
}

export function NewExtension({
  scope,
  search,
}: Readonly<{ scope: EnvironmentScope; search: NewExtensionSearch }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const openDetail = useOpenDetail(scope);
  const [draft, setDraft] = useState<ExtensionDraft>(() =>
    blankDraft(search.type ?? "client", search),
  );
  const [reviewing, setReviewing] = useState(false);
  const [checked, setChecked] = useState(false);
  const planned = createWrite(draft);

  return (
    <div className="flex flex-col gap-8">
      <Heading level={2}>New extension</Heading>
      <ExtensionFields
        draft={draft}
        issues={checked && !planned.ok ? planned.issues : []}
        onChange={setDraft}
        scope={scope}
      />
      <div className="flex justify-end gap-3">
        <Button href={`${environmentPath(scope)}/extensions`} variant="ghost">
          Cancel
        </Button>
        <Button
          onClick={() => {
            setChecked(true);
            if (planned.ok) setReviewing(true);
          }}
        >
          Create extension
        </Button>
      </div>
      {planned.ok ? (
        <ActionDialog
          confirmLabel="Create extension"
          confirmation={typedConfirmation(environment.type, { phrase: draft.name.trim() })}
          description={
            <>
              Create the {KIND_LABELS[draft.type].toLowerCase()} extension{" "}
              <Code>{draft.name.trim()}</Code>.
              {planned.write.artifact ? " The source uploads and compiles first." : ""}
            </>
          }
          onClose={() => setReviewing(false)}
          onSuccess={(created) => {
            void invalidateExtensions(queryClient, scope);
            openDetail(created);
          }}
          open={reviewing}
          retryNotice={RETRY_NOTICE}
          run={(idempotencyKey: string) =>
            createExtensionFn({ data: { ...planned.write, idempotencyKey, scope } })
          }
          successMessage={(created) => `Created ${created.name}`}
          title="Create extension"
        />
      ) : null}
    </div>
  );
}

export function EditExtension({
  locator,
  scope,
}: Readonly<{ locator: ExtensionLocator; scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(extensionQuery(scope, locator));
  if (data.kind !== "found") return <AbsentExtension detail={data} />;
  const { summary, tool } = data;
  const detailPath = `${environmentPath(scope)}/extensions/${summary.id}?${new URLSearchParams({ name: summary.name })}`;
  const draft = tool ? editDraft(tool) : undefined;
  if (tool === undefined || draft === undefined) {
    return (
      <Text>
        {summary.execution.type === "vendor_mcp"
          ? "Vendor MCP tools change only through Sync tools on their connection."
          : "Archived extensions cannot be edited."}{" "}
        <TextLink href={detailPath}>Back to {summary.name}</TextLink>
      </Text>
    );
  }
  return <ExtensionEditor detailPath={detailPath} initial={draft} scope={scope} tool={tool} />;
}

/**
 * `tool` is the latest read. When a newer version arrives, after a version conflict or a refetch,
 * the operator's edits move onto it, so the next save sends only those edits with its version.
 */
function ExtensionEditor({
  detailPath,
  initial,
  scope,
  tool,
}: Readonly<{
  detailPath: string;
  initial: ExtensionDraft;
  scope: EnvironmentScope;
  tool: ExtensionTool;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const openDetail = useOpenDetail(scope);
  const [edit, setEdit] = useState({
    loaded: initial,
    draft: initial,
    rebased: false,
    version: tool.version,
  });
  if (edit.version !== tool.version) {
    setEdit({
      loaded: initial,
      draft: rebaseDraft(edit.loaded, initial, edit.draft),
      rebased: true,
      version: tool.version,
    });
  }
  const { draft } = edit;
  const [reviewing, setReviewing] = useState(false);
  const [checked, setChecked] = useState(false);
  const planned = updateWrite(tool, draft);

  return (
    <div className="flex flex-col gap-8">
      <Heading level={2}>Edit {tool.name}</Heading>
      {edit.rebased ? (
        <Text>
          Version {tool.version} was saved while you edited. Fields you left alone now show it, and
          your changes stay on top. Review them before saving.
        </Text>
      ) : null}
      <ExtensionFields
        draft={draft}
        issues={checked && !planned.ok ? planned.issues : []}
        onChange={(next) => setEdit((current) => ({ ...current, draft: next }))}
        scope={scope}
        tool={tool}
      />
      <div className="flex justify-end gap-3">
        <Button href={detailPath} variant="ghost">
          Cancel
        </Button>
        <Button
          onClick={() => {
            setChecked(true);
            if (planned.ok) setReviewing(true);
          }}
        >
          Save changes
        </Button>
      </div>
      {planned.ok ? (
        <ActionDialog
          confirmLabel="Save changes"
          confirmation={typedConfirmation(environment.type, { phrase: tool.name })}
          description={
            <>
              Update <Code>{tool.name}</Code> from version {tool.version}.
              {planned.write.artifact ? " The new source uploads and compiles first." : ""}
            </>
          }
          onClose={() => setReviewing(false)}
          onSuccess={(updated) => {
            void invalidateExtensions(queryClient, scope);
            openDetail(updated);
          }}
          open={reviewing}
          retryNotice={RETRY_NOTICE}
          run={(idempotencyKey: string) =>
            refreshOnConflict(
              updateExtensionFn({
                data: { ...planned.write, idempotencyKey, scope, toolName: tool.name },
              }),
              () => invalidateExtensions(queryClient, scope),
            )
          }
          successMessage={(updated) => `Saved ${updated.name} as version ${updated.version}`}
          title="Save changes"
        />
      ) : null}
    </div>
  );
}
