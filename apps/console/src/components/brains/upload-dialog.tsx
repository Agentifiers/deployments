import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { BrainSource } from "../../brains/model.ts";
import {
  BRAIN_FILE_ACCEPT,
  BRAIN_FILE_PROBLEMS,
  brainFileProblem,
  brainMediaType,
  CONSOLE_BRAIN_UPLOAD_MAX_LABEL,
  MAX_UPLOAD_IDENTITY_LENGTH,
  MAX_UPLOAD_TITLE_LENGTH,
  type BrainFileProblem,
  type BrainMediaType,
} from "../../brains/upload.ts";
import { uploadBrainDocumentFn } from "../../data/brain-mutations.ts";
import { invalidateBrain } from "../../data/brain-queries.ts";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { ActionDialog } from "../action-dialog.tsx";
import { fileBase64 } from "../file-base64.ts";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";

interface UploadDraft {
  readonly file: File;
  readonly identity: string;
  readonly mediaType: BrainMediaType;
  readonly title: string;
}

const withoutExtension = (name: string) => name.replace(/\.[^.]+$/u, "") || name;

export function UploadDocumentDialog({
  brainPath,
  onClose,
  open,
  organizationId,
  source,
}: Readonly<{
  brainPath: string;
  onClose: () => void;
  open: boolean;
  organizationId: string;
  source: BrainSource;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [refused, setRefused] = useState<BrainFileProblem>();
  const [identity, setIdentity] = useState("");
  const [title, setTitle] = useState("");
  const held = useKeyedSnapshot<UploadDraft | undefined>();
  const lastKey = useRef<string | undefined>(undefined);
  const [file] = files;
  const problem = file ? brainFileProblem(file) : refused;
  const mediaType = file ? brainMediaType(file.name, file.type) : undefined;
  const draft: UploadDraft | undefined =
    file && mediaType && problem === undefined
      ? { file, identity: identity.trim(), mediaType, title: title.trim() }
      : undefined;
  return (
    <ActionDialog
      confirmLabel="Upload"
      description={`Uploads one file into ${source.name}. Uploading again with the same identity replaces the document's content.`}
      invalid={draft === undefined || draft.identity === ""}
      onClose={() => {
        setFiles([]);
        setRefused(undefined);
        setIdentity("");
        setTitle("");
        onClose();
      }}
      onSuccess={({ documentId }: { readonly documentId: string }) => {
        void invalidateBrain(queryClient, organizationId, source.brainId);
        void navigate({ to: `${brainPath}/documents/${documentId}` });
      }}
      open={open}
      retryNotice="The file may already be stored. Upload again to finish this upload."
      run={async (idempotencyKey, resend) => {
        const retry = lastKey.current === idempotencyKey;
        lastKey.current = idempotencyKey;
        const sent = held(idempotencyKey, resend, draft);
        if (!sent) throw new TypeError("Choose a file to upload.");
        return uploadBrainDocumentFn({
          data: {
            brainId: source.brainId,
            contentBase64: await fileBase64(sent.file),
            externalItemIdentity: sent.identity,
            idempotencyKey,
            mediaType: sent.mediaType,
            retry,
            scope: { organizationId },
            sourceId: source.id,
            ...(sent.title === "" ? {} : { title: sent.title }),
          },
        });
      }}
      successMessage="Uploaded"
      title="Upload a document"
    >
      <Field>
        <Label>File</Label>
        <FileInput
          accept={BRAIN_FILE_ACCEPT}
          hint={`Markdown, plain text, CSV, JSON, HTML, or PDF, up to ${CONSOLE_BRAIN_UPLOAD_MAX_LABEL}`}
          onChange={(picked) => {
            const [next] = picked;
            setFiles(picked);
            setRefused(undefined);
            setIdentity(next?.name ?? "");
            setTitle(next ? withoutExtension(next.name) : "");
          }}
          onReject={([rejection]) => {
            setFiles([]);
            setRefused(
              rejection ? (brainFileProblem(rejection.file) ?? "unsupported_type") : undefined,
            );
          }}
          value={files}
        />
        {problem ? <ErrorMessage>{BRAIN_FILE_PROBLEMS[problem]}</ErrorMessage> : null}
      </Field>
      <Field>
        <Label>Title</Label>
        <Input
          autoComplete="off"
          maxLength={MAX_UPLOAD_TITLE_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </Field>
      <Field>
        <Label>Identity</Label>
        <Description>
          The document&apos;s name in this source. A new upload with the same identity becomes the
          document&apos;s next version.
        </Description>
        <Input
          autoComplete="off"
          maxLength={MAX_UPLOAD_IDENTITY_LENGTH}
          onChange={(event) => setIdentity(event.target.value)}
          value={identity}
        />
      </Field>
    </ActionDialog>
  );
}
