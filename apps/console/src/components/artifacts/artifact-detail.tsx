import { Copy01Icon, Delete02Icon, PlayCircleIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import {
  DOWNLOAD_ONLY_COPY,
  PREVIEW_TEXT_BYTES,
  previewDecision,
  type PreviewDecision,
} from "../../artifacts/preview.ts";
import { INPUT_ARTIFACT_TYPE } from "../../artifacts/upload.ts";
import { artifactTextQuery } from "../../data/artifact-queries.ts";
import { deleteArtifactFn } from "../../data/artifact-mutations.ts";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import { createArtifactLinkFn } from "../../data/thread-mutations.ts";
import { artifactQuery } from "../../data/thread-queries.ts";
import { formatByteSize } from "../../runs/views.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { Artifact } from "../../server/artifact-data.ts";
import { CodeBlock, CodeBlockCopyButton } from "@/components/reui/code-block/code-block";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { toast } from "@/components/ui/sonner";
import { Code, Text, TextLink } from "@/components/ui/text";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { FreshLinkButton } from "../fresh-link.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { RetentionDialog } from "../runs/artifact-list.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { StartRunDialog } from "./start-run-dialog.tsx";
import { StatusBadge } from "@/components/status-badge";

const PREVIEW_LINES = 40;

function TextPreview({
  artifact,
  decision,
  scope,
}: Readonly<{
  artifact: Artifact;
  decision: Extract<PreviewDecision, { kind: "text" }>;
  scope: EnvironmentScope;
}>) {
  const { data, error, isPending } = useQuery(artifactTextQuery(scope, artifact.artifactId));
  if (isPending) return <Text>Reading the file…</Text>;
  if (error) return <Text>{describeProblem(error, "The file could not be read").title}</Text>;
  if (data.kind === "binary") return <Text>{DOWNLOAD_ONLY_COPY.binary}</Text>;
  return (
    <div className="flex flex-col gap-2">
      <CodeBlock
        code={data.text}
        defaultWrap
        label={artifact.fileName ?? artifact.name}
        maxLines={PREVIEW_LINES}
        {...(decision.language ? { language: decision.language } : {})}
      >
        <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy the text" }} />
      </CodeBlock>
      {data.truncated ? (
        <Text>
          Shows the first {formatByteSize(PREVIEW_TEXT_BYTES)} of{" "}
          {formatByteSize(artifact.byteSize)}. Download the file to read the rest.
        </Text>
      ) : null}
    </div>
  );
}

/**
 * The image loads through a signed link the console server mints. An `<img>` never runs script,
 * and the link's attachment header stops the storage origin rendering anything if it is opened.
 */
function ImagePreview({
  artifact,
  scope,
}: Readonly<{ artifact: Artifact; scope: EnvironmentScope }>) {
  const { data, error, isPending } = useQuery({
    queryFn: () =>
      createArtifactLinkFn({
        data: { artifactId: artifact.artifactId, purpose: "preview", scope },
      }),
    queryKey: ["artifact-image", artifact.artifactId],
    staleTime: 50_000,
  });
  if (isPending) return <Text>Loading the image…</Text>;
  if (error) return <Text>{describeProblem(error, "The image could not be loaded").title}</Text>;
  if (new URL(data.url).protocol !== "https:") return <Text>{DOWNLOAD_ONLY_COPY.unsupported}</Text>;
  return (
    <img
      alt={artifact.name}
      className="max-h-[32rem] max-w-full rounded-lg border bg-muted object-contain"
      referrerPolicy="no-referrer"
      src={data.url}
    />
  );
}

function Preview({ artifact, scope }: Readonly<{ artifact: Artifact; scope: EnvironmentScope }>) {
  const decision = previewDecision(artifact);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Preview</Subheading>
      {decision.kind === "image" ? (
        <ImagePreview artifact={artifact} scope={scope} />
      ) : decision.kind === "text" ? (
        <TextPreview artifact={artifact} decision={decision} scope={scope} />
      ) : (
        <Text>{DOWNLOAD_ONLY_COPY[decision.reason]}</Text>
      )}
    </section>
  );
}

function CopyLinkButton({
  artifactId,
  scope,
}: Readonly<{ artifactId: string; scope: EnvironmentScope }>) {
  const [expiresAt, setExpiresAt] = useState<string>();
  const [pending, setPending] = useState(false);
  const { copyToClipboard } = useCopyToClipboard({
    timeout: 0,
    onError: () => toast.error("Copying failed. Download the file instead."),
  });
  async function copy() {
    setPending(true);
    try {
      const link = await createArtifactLinkFn({ data: { artifactId, purpose: "copy", scope } });
      copyToClipboard(link.url);
      setExpiresAt(link.expiresAt);
      toast.success("Copied a download link", {
        description: `Anyone with the link can download the file until ${new Date(link.expiresAt).toLocaleString()}.`,
      });
    } catch (error) {
      const problem = describeProblem(
        error instanceof Error ? error : new Error(String(error)),
        "The link could not be created",
      );
      toast.error(problem.title, problem.description ? { description: problem.description } : {});
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Button disabled={pending} onClick={() => void copy()} variant="outline">
        <Icon icon={Copy01Icon} />
        Copy link
      </Button>
      {expiresAt ? (
        <Text>
          Link expires <Timestamp value={expiresAt} />
        </Text>
      ) : null}
    </div>
  );
}

function Metadata({ artifact }: Readonly<{ artifact: Artifact }>) {
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Metadata</Subheading>
      {artifact.metadataJson ? (
        <CodeBlock
          code={artifact.metadataJson}
          defaultWrap
          label="Metadata"
          language="json"
          maxLines={23}
        >
          <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy metadata" }} />
        </CodeBlock>
      ) : (
        <Text>This artifact has no metadata.</Text>
      )}
    </section>
  );
}

type Dialog = "delete" | "retention" | "start-run";

/** `offerRun` opens the start-run dialog, as the upload dialog asks after an input upload. */
export function ArtifactDetail({
  artifactId,
  offerRun = false,
  scope,
}: Readonly<{ artifactId: string; offerRun?: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: artifact } = useSuspenseQuery(artifactQuery(scope, artifactId));
  const [dialog, setDialog] = useState<Dialog | undefined>(offerRun ? "start-run" : undefined);
  const base = environmentPath(scope);
  const available = artifact.status === "available";
  const canStartRun =
    available &&
    artifact.type === INPUT_ARTIFACT_TYPE &&
    artifact.threadId !== undefined &&
    artifact.input?.kind !== "unusable" &&
    shell.access.submitAgentRun;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col gap-1">
          <Heading>{artifact.name}</Heading>
          <Text>
            <Code>{artifact.fileName ?? artifact.name}</Code> · {formatByteSize(artifact.byteSize)}
          </Text>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {shell.access.createArtifactAccessUrl ? (
            <>
              <FreshLinkButton
                disabled={!available}
                disposition="download"
                label="Download"
                mint={() =>
                  createArtifactLinkFn({ data: { artifactId, purpose: "download", scope } })
                }
              />
              {available ? <CopyLinkButton artifactId={artifactId} scope={scope} /> : null}
            </>
          ) : null}
          {canStartRun ? (
            <Button onClick={() => setDialog("start-run")} variant="outline">
              <Icon icon={PlayCircleIcon} />
              Start a run with this file
            </Button>
          ) : null}
          {shell.access.updateArtifactRetention ? (
            <Button onClick={() => setDialog("retention")} variant="outline">
              Retention
            </Button>
          ) : null}
          {shell.access.deleteArtifact ? (
            <Button onClick={() => setDialog("delete")} variant="destructive">
              <Icon icon={Delete02Icon} />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>Status</DescriptionTerm>
        <DescriptionDetails>
          <StatusBadge status={artifact.status} />
        </DescriptionDetails>
        <DescriptionTerm>Type</DescriptionTerm>
        <DescriptionDetails>{artifact.type}</DescriptionDetails>
        <DescriptionTerm>Content type</DescriptionTerm>
        <DescriptionDetails>
          <Code>{artifact.contentType}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Who can read it</DescriptionTerm>
        <DescriptionDetails>
          {artifact.visibility === "private" ? "Only its owner" : "Everyone in the organization"}
        </DescriptionDetails>
        <DescriptionTerm>Run</DescriptionTerm>
        <DescriptionDetails>
          {artifact.runId ? (
            <TextLink href={`${base}/runs/${artifact.runId}`}>
              <Code>{artifact.runId}</Code>
            </TextLink>
          ) : (
            "None"
          )}
        </DescriptionDetails>
        <DescriptionTerm>Thread</DescriptionTerm>
        <DescriptionDetails>
          {artifact.threadId ? (
            <TextLink href={`${base}/threads/${artifact.threadId}`}>
              <Code>{artifact.threadId}</Code>
            </TextLink>
          ) : (
            "None"
          )}
        </DescriptionDetails>
        {artifact.input ? (
          <>
            <DescriptionTerm>Run input</DescriptionTerm>
            <DescriptionDetails>
              {artifact.input.kind === "unusable" ? artifact.input.message : artifact.input.kind}
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={artifact.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Kept until</DescriptionTerm>
        <DescriptionDetails>
          {artifact.retentionExpiresAt ? (
            <Timestamp value={artifact.retentionExpiresAt} />
          ) : (
            "Until it, its thread, or the organization is deleted"
          )}
        </DescriptionDetails>
        <DescriptionTerm>Artifact ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={artifact.artifactId} />
        </DescriptionDetails>
      </DescriptionList>
      <Preview artifact={artifact} scope={scope} />
      <Metadata artifact={artifact} />
      {dialog === "retention" ? (
        <Suspense fallback={null}>
          <RetentionDialog
            artifactId={artifactId}
            onClose={() => setDialog(undefined)}
            scope={scope}
          />
        </Suspense>
      ) : null}
      <ActionDialog
        confirmLabel="Delete artifact"
        confirmation={typedConfirmation(environment.type, { destructive: true, phrase: "delete" })}
        description="The artifact disappears from every list at once, and the platform then erases its stored bytes. Download links already handed out keep working until they expire, at most one hour."
        destructive
        onClose={() => setDialog(undefined)}
        onSuccess={() => {
          void invalidateRuntime(queryClient, scope);
          void navigate({ to: `${base}/artifacts` });
        }}
        open={dialog === "delete"}
        runOnce={() => deleteArtifactFn({ data: { artifactId, scope } })}
        successMessage="Artifact deleted"
        title={`Delete ${artifact.name}?`}
      />
      {canStartRun && artifact.threadId ? (
        <StartRunDialog
          artifactId={artifactId}
          onClose={() => setDialog(undefined)}
          open={dialog === "start-run"}
          scope={scope}
          threadId={artifact.threadId}
        />
      ) : null}
    </div>
  );
}
