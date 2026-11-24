"use client";

import { Cancel01Icon, Upload01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import * as React from "react";

import { FileType, getFileType } from "@/components/reui/file-type";
import { Button } from "@/components/ui/button";
import { fileKey, useFileUpload, type FileRejection } from "@/hooks/use-file-upload";

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

type FileInputProps = {
  accept?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  hint?: React.ReactNode;
  maxSize?: number | undefined;
  multiple?: boolean | undefined;
  onChange: (files: File[]) => void;
  onReject?: ((rejections: FileRejection[]) => void) | undefined;
  ref?: React.Ref<HTMLInputElement> | undefined;
  value: readonly File[];
} & Omit<
  React.ComponentProps<"input">,
  | "accept"
  | "className"
  | "defaultValue"
  | "disabled"
  | "multiple"
  | "onChange"
  | "ref"
  | "type"
  | "value"
>;

export function FileInput({
  accept,
  "aria-describedby": describedBy,
  className,
  disabled = false,
  hint,
  maxSize,
  multiple = false,
  onChange,
  onReject,
  ref,
  value,
  ...props
}: FileInputProps) {
  const listId = React.useId();
  const [{ isDragging }, upload] = useFileUpload({
    accept,
    maxSize,
    multiple,
    files: value,
    onFilesChange: onChange,
    onReject,
  });

  const hasFiles = value.length > 0;
  const describedByIds = [describedBy, hasFiles ? listId : undefined].filter(Boolean).join(" ");

  return (
    <div data-slot="file-input" className={cn("flex w-full flex-col gap-3", className)}>
      <div
        data-dragging={isDragging || undefined}
        className="group/file-input relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input px-4 py-6 text-center text-sm text-foreground transition-colors hover:border-ring/60 has-[input:disabled]:pointer-events-none has-[input:disabled]:opacity-50 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 has-[input[aria-invalid=true]]:border-destructive data-dragging:border-ring data-dragging:bg-ring/5"
        onDragEnter={upload.handleDragEnter}
        onDragOver={upload.handleDragOver}
        onDragLeave={upload.handleDragLeave}
        onDrop={upload.handleDrop}
      >
        <InputPrimitive
          {...upload.getInputProps({ ...props, ref })}
          aria-describedby={describedByIds || undefined}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
          disabled={disabled}
        />
        <HugeiconsIcon
          aria-hidden="true"
          icon={Upload01Icon}
          strokeWidth={1.8}
          className="size-5 text-muted-foreground group-data-dragging/file-input:text-ring"
        />
        <span className="font-medium">
          {isDragging
            ? "Drop to upload"
            : hasFiles && !multiple
              ? "Choose a different file"
              : "Choose a file or drag it here"}
        </span>
        <span data-slot="file-input-hint" className="text-muted-foreground">
          {hint ??
            [
              accept
                ? accept
                    .split(",")
                    .map((token) => token.trim())
                    .join(", ")
                : null,
              maxSize !== undefined ? `up to ${formatFileSize(maxSize)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
        </span>
      </div>
      {hasFiles && (
        <ul
          id={listId}
          aria-label="Selected files"
          className="flex flex-col divide-y divide-border/50 rounded-lg border"
        >
          {value.map((file, index) => (
            <li key={fileKey(file)} className="flex items-center gap-3 px-3 py-2 text-sm">
              <FileType aria-hidden="true" size="xs" type={getFileType(file.name)} />
              <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatFileSize(file.size)}
              </span>
              <Button
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => upload.removeFile(index)}
                size="icon-sm"
                variant="ghost"
              >
                <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
