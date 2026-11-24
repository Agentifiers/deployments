"use client";

import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type InputHTMLAttributes,
  type Ref,
} from "react";

export type FileRejection = {
  file: File;
  reason: "accept" | "size";
};

export type FileUploadOptions = {
  /** Comma-separated `.ext`, `type/*`, or exact MIME tokens, matched case-insensitively. */
  accept?: string | undefined;
  maxSize?: number | undefined; // in bytes
  multiple?: boolean | undefined; // Defaults to false
  /** The current selection. The hook is controlled: it reports a new selection to `onFilesChange`. */
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  onReject?: ((rejections: FileRejection[]) => void) | undefined;
};

export type FileUploadState = {
  isDragging: boolean;
};

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  ref?: Ref<HTMLInputElement> | undefined;
};

export type FileUploadActions = {
  addFiles: (files: Iterable<File>) => void;
  removeFile: (index: number) => void;
  handleDragEnter: (e: DragEvent<HTMLElement>) => void;
  handleDragLeave: (e: DragEvent<HTMLElement>) => void;
  handleDragOver: (e: DragEvent<HTMLElement>) => void;
  handleDrop: (e: DragEvent<HTMLElement>) => void;
  handleFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  getInputProps: (
    props?: InputProps,
  ) => InputHTMLAttributes<HTMLInputElement> & { ref: (node: HTMLInputElement | null) => void };
};

/** Two picks of the same file on disk share a key, so they select once. */
export const fileKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

function acceptsFile(accept: string | undefined, file: File) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith(".")) return name.endsWith(token);
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
      return type === token;
    });
}

export const useFileUpload = ({
  accept,
  maxSize = Number.POSITIVE_INFINITY,
  multiple = false,
  files,
  onFilesChange,
  onReject,
}: FileUploadOptions): [FileUploadState, FileUploadActions] => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // A disabled Fieldset disables the input without a prop, so ask the element.
  const locked = () => inputRef.current?.matches(":disabled") ?? false;

  const validateFile = (file: File): FileRejection["reason"] | null => {
    if (!acceptsFile(accept, file)) return "accept";
    if (file.size > maxSize) return "size";
    return null;
  };

  const addFiles = (newFiles: Iterable<File>) => {
    const added: File[] = [];
    const rejected: FileRejection[] = [];
    const seen = new Set(multiple ? files.map(fileKey) : []);
    for (const file of newFiles) {
      const reason = validateFile(file);
      if (reason) rejected.push({ file, reason });
      else if (!seen.has(fileKey(file))) {
        seen.add(fileKey(file));
        added.push(file);
      }
    }
    // A single-file input keeps its selection unless the pick holds an accepted file, which replaces it.
    // Report accepted files first so a consumer that resets errors on change still sees the rejection.
    if (added.length > 0) onFilesChange(multiple ? [...files, ...added] : added.slice(0, 1));
    if (rejected.length > 0) onReject?.(rejected);
  };

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, position) => position !== index));
    // The remove button unmounts with its row; keep focus in the control.
    inputRef.current?.focus();
  };

  const handleDragEnter = (e: DragEvent<HTMLElement>) => {
    if (locked()) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    if (locked()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  };

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (locked()) return;
    addFiles(e.dataTransfer.files);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(e.currentTarget.files ?? []);
    // Clear so re-choosing the same file fires change again.
    e.currentTarget.value = "";
  };

  const getInputProps = ({ ref, ...props }: InputProps = {}) => ({
    ...props,
    type: "file" as const,
    onChange: handleFileChange,
    accept,
    multiple,
    ref: (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
  });

  return [
    { isDragging },
    {
      addFiles,
      removeFile,
      handleDragEnter,
      handleDragLeave,
      handleDragOver,
      handleDrop,
      handleFileChange,
      getInputProps,
    },
  ];
};
