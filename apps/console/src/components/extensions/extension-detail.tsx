import { Archive02Icon, PencilEdit02Icon, PuzzleIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { archiveExtensionFn } from "../../data/extension-mutations.ts";
import {
  extensionQuery,
  hostedCodeArtifactQuery,
  invalidateExtensions,
} from "../../data/extension-queries.ts";
import type { ExtensionTool } from "../../extensions/extension-draft.ts";
import { KIND_LABELS, type ExtensionLocator } from "../../extensions/extension-state.ts";
import { formatExact } from "../../observability/format.ts";
import type { ExtensionDetail as Detail } from "../../server/extension-data.ts";
import { formatFileSize } from "@/components/ui/file-input";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { ExtensionSummary } from "../../server/tool-directory.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { CodeBlock } from "@/components/reui/code-block/code-block";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { StatusBadge } from "@/components/status-badge";

export function AbsentExtension({
  detail,
}: Readonly<{ detail: Exclude<Detail, { kind: "found" }> }>) {
  return detail.kind === "missing" ? (
    <ListEmpty
      docs="/docs/capabilities/extensions-and-hosted-code"
      icon={PuzzleIcon}
      title="Extension not found"
    >
      This environment has no extension with this ID.
    </ListEmpty>
  ) : (
    <Text>
      This environment has more extensions than the console reads, and this one is not among the
      first {formatExact(detail.cappedAt)}, so the console cannot show it.
    </Text>
  );
}

export function ExtensionDetail({
  locator,
  scope,
}: Readonly<{ locator: ExtensionLocator; scope: EnvironmentScope }>) {
  const { data } = useSuspenseQuery(extensionQuery(scope, locator));
  return data.kind === "found" ? (
    <FoundExtension detail={data} scope={scope} />
  ) : (
    <AbsentExtension detail={data} />
  );
}

function FoundExtension({
  detail: { summary, tool },
  scope,
}: Readonly<{ detail: Extract<Detail, { kind: "found" }>; scope: EnvironmentScope }>) {
  const { access } = useSuspenseQuery(organizationShellQuery(scope.organizationId)).data;
  const [archiving, setArchiving] = useState(false);
  const { execution } = summary;
  const editable = tool !== undefined && execution.type !== "vendor_mcp";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading className="font-mono" level={2}>
          {summary.name}
        </Heading>
        <StatusBadge status={summary.status} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {editable && access.updateExtensionTool ? (
            <Button
              href={`${environmentPath(scope)}/extensions/${summary.id}/edit?${new URLSearchParams({ name: summary.name })}`}
              variant="outline"
            >
              <Icon icon={PencilEdit02Icon} />
              Edit
            </Button>
          ) : null}
          {summary.status === "active" && access.archiveExtensionTool ? (
            <Button variant="destructive" onClick={() => setArchiving(true)}>
              <Icon icon={Archive02Icon} />
              Archive
            </Button>
          ) : null}
        </div>
      </div>
      {tool?.description ? <Text>{tool.description}</Text> : null}
      {summary.status === "active" ? null : (
        <Text>
          The API returns the description and schemas only for an active extension. Archiving
          released the name, so a new extension may now use it.
        </Text>
      )}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={summary.id} />
        </DescriptionDetails>
        <DescriptionTerm>Execution type</DescriptionTerm>
        <DescriptionDetails>{KIND_LABELS[execution.type]}</DescriptionDetails>
        <DescriptionTerm>Effect</DescriptionTerm>
        <DescriptionDetails>{summary.effect}</DescriptionDetails>
        <DescriptionTerm>Default policy action</DescriptionTerm>
        <DescriptionDetails>
          <StatusBadge status={summary.defaultPolicyAction} />
        </DescriptionDetails>
        <DescriptionTerm>Required scopes</DescriptionTerm>
        <DescriptionDetails>
          {summary.requiredScopes.length === 0 ? "None" : summary.requiredScopes.join(", ")}
        </DescriptionDetails>
        {summary.providerKey ? (
          <>
            <DescriptionTerm>Provider</DescriptionTerm>
            <DescriptionDetails>
              <Code>{summary.providerKey}</Code>
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Version</DescriptionTerm>
        <DescriptionDetails>{summary.version}</DescriptionDetails>
        <ExecutionTerms
          execution={execution}
          hasCallbackAuth={tool?.hasCallbackAuth}
          scope={scope}
        />
        {tool ? <RuntimeTerms execution={tool.execution} /> : null}
        {tool ? (
          <>
            <DescriptionTerm>Updated</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={tool.updatedAt} />
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>
      {execution.type === "hosted_code" ? (
        <section className="flex flex-col gap-4">
          <Subheading>Artifact</Subheading>
          <SectionBoundary resetKey={execution.contentHash}>
            <HostedCodeArtifact contentHash={execution.contentHash} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
      {tool ? (
        <section className="flex flex-col gap-4">
          <Subheading>Input schema</Subheading>
          <CodeBlock
            code={JSON.stringify(tool.inputSchema, null, 2)}
            label="Input schema"
            language="json"
            maxLines={15}
          />
          {tool.outputSchema ? (
            <>
              <Subheading>Output schema</Subheading>
              <CodeBlock
                code={JSON.stringify(tool.outputSchema, null, 2)}
                label="Output schema"
                language="json"
                maxLines={15}
              />
            </>
          ) : null}
        </section>
      ) : null}
      {summary.status === "active" && access.archiveExtensionTool ? (
        <ArchiveExtensionDialog
          extension={summary}
          onClose={() => setArchiving(false)}
          open={archiving}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function RuntimeTerms({ execution }: Readonly<{ execution: ExtensionTool["execution"] }>) {
  switch (execution.type) {
    case "client":
      return (
        <>
          <DescriptionTerm>Timeout</DescriptionTerm>
          <DescriptionDetails>
            {execution.timeoutMs === undefined ? "Default" : `${execution.timeoutMs} ms`}
          </DescriptionDetails>
        </>
      );
    case "hosted_code":
      return (
        <>
          <DescriptionTerm>Entrypoint</DescriptionTerm>
          <DescriptionDetails>
            <Code>{execution.entrypoint}</Code>
          </DescriptionDetails>
          <DescriptionTerm>Limits</DescriptionTerm>
          <DescriptionDetails>
            {execution.timeoutMs} ms, {execution.memoryMiB} MiB, network {execution.network}
          </DescriptionDetails>
        </>
      );
    default:
      return null;
  }
}

function ExecutionTerms({
  execution,
  hasCallbackAuth,
  scope,
}: Readonly<{
  execution: ExtensionSummary["execution"];
  hasCallbackAuth: boolean | undefined;
  scope: EnvironmentScope;
}>) {
  switch (execution.type) {
    case "mcp":
      return (
        <>
          <DescriptionTerm>MCP server</DescriptionTerm>
          <DescriptionDetails>
            <ResourceLink
              scope={scope}
              to={{ kind: "mcpServer", mcpServerId: execution.mcpServerId }}
            >
              {execution.mcpServerId}
            </ResourceLink>
          </DescriptionDetails>
          <DescriptionTerm>Remote tool</DescriptionTerm>
          <DescriptionDetails>
            <Code>{execution.remoteToolName}</Code>
          </DescriptionDetails>
        </>
      );
    case "vendor_mcp":
      return (
        <>
          <DescriptionTerm>Remote tool</DescriptionTerm>
          <DescriptionDetails>
            <Code>{execution.remoteToolName}</Code> on <Code>{execution.providerKey}</Code>. Sync
            tools on a connection of this provider creates and updates it.
          </DescriptionDetails>
        </>
      );
    case "http_callback":
      return (
        <>
          <DescriptionTerm>Endpoint</DescriptionTerm>
          <DescriptionDetails className="font-mono">
            {execution.endpointOrigin}
            {execution.endpointPath}
          </DescriptionDetails>
          {hasCallbackAuth === undefined ? null : (
            <>
              <DescriptionTerm>Callback secret</DescriptionTerm>
              <DescriptionDetails>{hasCallbackAuth ? "Stored" : "Missing"}</DescriptionDetails>
            </>
          )}
        </>
      );
    case "client":
      return null;
    case "hosted_code":
      return (
        <>
          <DescriptionTerm>Secrets</DescriptionTerm>
          <DescriptionDetails>
            {execution.secretNames.length === 0 ? "None" : execution.secretNames.join(", ")}
          </DescriptionDetails>
        </>
      );
  }
}

function HostedCodeArtifact({
  contentHash,
  scope,
}: Readonly<{ contentHash: string; scope: EnvironmentScope }>) {
  const { data: artifact } = useSuspenseQuery(hostedCodeArtifactQuery(scope, contentHash));
  return (
    <DescriptionList>
      <DescriptionTerm>Content hash</DescriptionTerm>
      <DescriptionDetails className="font-mono break-all">
        {artifact.contentHash}
      </DescriptionDetails>
      <DescriptionTerm>Source</DescriptionTerm>
      <DescriptionDetails>
        {artifact.sourceLanguage}, {formatFileSize(artifact.sourceByteSize)}
      </DescriptionDetails>
      <DescriptionTerm>Runs as</DescriptionTerm>
      <DescriptionDetails>
        {artifact.language}, {formatFileSize(artifact.byteSize)}
      </DescriptionDetails>
      <DescriptionTerm>Uploaded</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={artifact.createdAt} />
      </DescriptionDetails>
    </DescriptionList>
  );
}

function ArchiveExtensionDialog({
  extension,
  onClose,
  open,
  scope,
}: Readonly<{
  extension: ExtensionSummary;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Archive extension"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: extension.name,
      })}
      description={
        <>
          Every deployment that calls <Code>{extension.name}</Code> loses the tool. Archiving cannot
          be undone, and the name becomes free for a new extension.
        </>
      }
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateExtensions(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        refreshOnConflict(
          archiveExtensionFn({
            data: {
              expectedVersion: extension.version,
              idempotencyKey,
              scope,
              toolName: extension.name,
            },
          }),
          () => invalidateExtensions(queryClient, scope),
        )
      }
      successMessage={`Archived ${extension.name}`}
      title="Archive extension"
    />
  );
}
