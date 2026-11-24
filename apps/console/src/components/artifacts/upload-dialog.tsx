import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  INPUT_ARTIFACT_TYPE,
  MAX_ARTIFACT_BYTES,
  MAX_INPUT_ARTIFACT_BYTES,
  fileProblem,
  runUpload,
  sha256Hex,
  uploadProblemText,
  xhrPut,
  type UploadState,
} from "../../artifacts/upload.ts";
import {
  completeArtifactUploadFn,
  createArtifactUploadFn,
  createInputThreadFn,
} from "../../data/artifact-mutations.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { parseRuntimeId } from "../../runs/filters.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Description,
  ErrorMessage,
  Field,
  Fieldset,
  Label,
  RadioField,
} from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Text } from "@/components/ui/text";

/** Where the upload is attached, per `createArtifactUpload`: the environment, or one thread. */
type Attachment = "environment" | "thread" | "run-input";

const ATTACHMENTS: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: Attachment;
}[] = [
  {
    description:
      "Kept in this environment for anyone with access to read, and for runs or tools that fetch it by ID.",
    label: "Environment file",
    value: "environment",
  },
  {
    description: "Attached to an existing thread, so it is listed with that thread's files.",
    label: "Thread file",
    value: "thread",
  },
  {
    description: `A private input file, up to ${MAX_INPUT_ARTIFACT_BYTES / 1024 / 1024} MiB, for an agent's next run to read. Opens a new thread on the deployment you choose.`,
    label: "Input for a new run",
    value: "run-input",
  },
];

const withoutExtension = (name: string) => name.replace(/\.[^.]+$/u, "") || name;

/** Browsers report a blank type for many files; the API needs a media type. */
const contentTypeOf = (file: File) => file.type || "application/octet-stream";

function metadataProblem(text: string): string | undefined {
  if (text.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? undefined
      : "Metadata must be a JSON object.";
  } catch {
    return "Metadata must be valid JSON.";
  }
}

function progressText(state: UploadState) {
  switch (state.kind) {
    case "hashing":
      return "Computing the file's SHA-256 digest…";
    case "creating":
      return "Creating the upload…";
    case "sending":
      return `Sending ${Math.round((state.sent / Math.max(state.total, 1)) * 100)}%`;
    case "completing":
      return "Verifying the stored file…";
    default:
      return undefined;
  }
}

export function UploadArtifactDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const labels = agentLabels(directory);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [attachment, setAttachment] = useState<Attachment>("environment");
  const [name, setName] = useState("");
  const [type, setType] = useState("file");
  const [threadText, setThreadText] = useState("");
  const [deploymentId, setDeploymentId] = useState("");
  const [visibility, setVisibility] = useState<"organization" | "private">("organization");
  const [metadata, setMetadata] = useState("");
  const [state, setState] = useState<UploadState>();
  const [file] = files;
  const isInput = attachment === "run-input";
  const limit = isInput ? MAX_INPUT_ARTIFACT_BYTES : MAX_ARTIFACT_BYTES;
  const sizeProblem = file ? fileProblem(file.size, limit) : undefined;
  const threadId = parseRuntimeId(threadText);
  const metadataError = metadataProblem(metadata);
  const busy = state !== undefined && state.kind !== "failed" && state.kind !== "done";
  const ready =
    file !== undefined &&
    sizeProblem === undefined &&
    name.trim() !== "" &&
    (isInput || type.trim() !== "") &&
    metadataError === undefined &&
    (attachment !== "thread" || threadId !== undefined) &&
    (attachment !== "run-input" || deploymentId !== "") &&
    !busy;

  const reset = () => {
    setFiles([]);
    setName("");
    setType("file");
    setThreadText("");
    setDeploymentId("");
    setMetadata("");
    setState(undefined);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  async function upload() {
    if (!file || !ready) return;
    let target: string | undefined;
    const outcome = await runUpload(
      file.size,
      limit,
      {
        complete: (artifactId) => completeArtifactUploadFn({ data: { artifactId, scope } }),
        create: async (sha256) => {
          target = isInput
            ? await createInputThreadFn({ data: { agentDeploymentId: deploymentId, scope } })
            : attachment === "thread"
              ? threadId
              : undefined;
          return createArtifactUploadFn({
            data: {
              request: {
                byteSize: file.size,
                contentType: contentTypeOf(file),
                fileName: file.name,
                ...(metadata.trim() === ""
                  ? {}
                  : { metadata: JSON.parse(metadata) as Readonly<Record<string, unknown>> }),
                name: name.trim(),
                sha256,
                ...(target ? { threadId: target } : {}),
                type: isInput ? INPUT_ARTIFACT_TYPE : type.trim(),
                visibility: isInput ? "private" : visibility,
              },
              scope,
            },
          });
        },
        now: () => Date.now(),
        put: xhrPut(file),
        sha256: () => sha256Hex(file),
      },
      setState,
    );
    if (outcome.kind === "failed" && outcome.artifactId) void invalidateRuntime(queryClient, scope);
    if (outcome.kind !== "done") return;
    await invalidateRuntime(queryClient, scope);
    reset();
    onClose();
    void navigate({
      search: isInput ? { startRun: true } : {},
      to: `${environmentPath(scope)}/artifacts/${outcome.artifactId}`,
    });
  }

  const progress = state ? progressText(state) : undefined;
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open={open}
    >
      <DialogContent showCloseButton={false} size="xl">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <DialogHeader>
            <DialogTitle>Upload an artifact</DialogTitle>
            <DialogDescription>
              The browser computes the file&apos;s SHA-256 digest, sends the file straight to the
              platform&apos;s storage, and the platform verifies it.
            </DialogDescription>
          </DialogHeader>
          <Fieldset className="contents" disabled={busy}>
            <Field>
              <Label>File</Label>
              <FileInput
                hint={`Any file up to ${limit / 1024 / 1024} MiB`}
                onChange={(picked) => {
                  const [next] = picked;
                  setFiles(picked);
                  setState(undefined);
                  if (next) setName(withoutExtension(next.name));
                }}
                value={files}
              />
              {sizeProblem ? <ErrorMessage>{uploadProblemText(sizeProblem)}</ErrorMessage> : null}
            </Field>
            <Field>
              <Label>Attach to</Label>
              <RadioGroup
                onValueChange={(value) => setAttachment(value as Attachment)}
                value={attachment}
              >
                {ATTACHMENTS.map((option) => (
                  <RadioField key={option.value}>
                    <RadioGroupItem value={option.value} />
                    <Label>{option.label}</Label>
                    <Description>{option.description}</Description>
                  </RadioField>
                ))}
              </RadioGroup>
            </Field>
            {attachment === "thread" ? (
              <Field>
                <Label>Thread ID</Label>
                <Input
                  aria-invalid={threadText.trim() !== "" && threadId === undefined}
                  autoComplete="off"
                  name="threadId"
                  onChange={(event) => setThreadText(event.target.value)}
                  value={threadText}
                />
              </Field>
            ) : null}
            {attachment === "run-input" ? (
              <Field>
                <Label>Deployment</Label>
                <NativeSelect
                  aria-label="Deployment"
                  onChange={(event) => setDeploymentId(event.target.value)}
                  value={deploymentId}
                >
                  <option value="">Choose a deployment</option>
                  {directory.deployments.map((deployment) => (
                    <option key={deployment.id} value={deployment.id}>
                      {labels.deployment(deployment.id)}
                    </option>
                  ))}
                </NativeSelect>
                <Description>
                  After the upload, the artifact page offers to start a run on this deployment that
                  reads the file.
                </Description>
              </Field>
            ) : null}
            <Field>
              <Label>Name</Label>
              <Input
                autoComplete="off"
                maxLength={255}
                name="name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </Field>
            {isInput ? null : (
              <>
                <Field>
                  <Label>Type</Label>
                  <Description>A label to filter by, such as report or dataset.</Description>
                  <Input
                    autoComplete="off"
                    maxLength={100}
                    name="type"
                    onChange={(event) => setType(event.target.value)}
                    value={type}
                  />
                </Field>
                <Field>
                  <Label>Who can read it</Label>
                  <NativeSelect
                    aria-label="Who can read it"
                    onChange={(event) =>
                      setVisibility(event.target.value === "private" ? "private" : "organization")
                    }
                    value={visibility}
                  >
                    <option value="organization">Everyone in the organization</option>
                    <option value="private">Only me</option>
                  </NativeSelect>
                </Field>
              </>
            )}
            <Field>
              <Label>Metadata</Label>
              <Description>Optional JSON object stored with the artifact.</Description>
              <Textarea
                aria-invalid={metadataError !== undefined}
                className="font-mono"
                name="metadata"
                onChange={(event) => setMetadata(event.target.value)}
                rows={3}
                value={metadata}
              />
              {metadataError ? <ErrorMessage>{metadataError}</ErrorMessage> : null}
            </Field>
          </Fieldset>
          {progress ? (
            <Text aria-live="polite" role="status">
              {progress}
            </Text>
          ) : null}
          {state?.kind === "sending" ? (
            <progress className="w-full" max={state.total} value={state.sent} />
          ) : null}
          {state?.kind === "failed" ? (
            <Callout variant="destructive">
              <CalloutTitle>The upload failed</CalloutTitle>
              <CalloutDescription>
                <p>{uploadProblemText(state.problem)}</p>
                {state.artifactId ? (
                  <p>
                    The unfinished artifact stays pending and expires on its own within 24 hours.
                  </p>
                ) : null}
              </CalloutDescription>
            </Callout>
          ) : null}
          <DialogFooter>
            <Button disabled={busy} onClick={close} variant="ghost">
              Cancel
            </Button>
            <Button disabled={!ready} type="submit">
              {busy ? "Uploading…" : state?.kind === "failed" ? "Upload again" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
