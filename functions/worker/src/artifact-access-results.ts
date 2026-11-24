import type { PlatformRecord } from "@deployments-ai/db";
import { jsonToolResult } from "./builtin-tool-support.ts";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
export type ArtifactAccessPurpose = "inspect" | "provider-handoff" | "share";

export function publicArtifact(record: Artifact, includeMetadata = true) {
  return {
    artifactId: record.data.id,
    byteSize: record.data.storage.byteSize,
    contentType: record.data.storage.contentType,
    createdAt: record.data.createdAt,
    fileName: record.data.storage.fileName,
    ...(includeMetadata ? { metadata: record.data.metadata } : {}),
    name: record.data.name,
    runId: record.data.runId,
    status: record.data.status,
    type: record.data.type,
    visibility: record.data.visibility,
  };
}

export function transientArtifactAccess(
  artifact: Artifact,
  expiresAt: string,
  url: string,
  purpose: ArtifactAccessPurpose,
) {
  return {
    content: `${JSON.stringify({ artifactId: artifact.data.id, expiresAt, url }, null, 2)}\n`,
    contentType: "application/json",
    fileName: `artifact-${artifact.data.id}-access.json`,
    label: `Ephemeral ${purpose === "provider-handoff" ? "provider handoff" : purpose} access`,
    metadata: { artifactId: artifact.data.id, kind: "artifact-access", purpose },
    type: "report" as const,
    visibility: "private" as const,
  };
}

export function preparedArtifactAccessResult(
  artifact: Artifact,
  expiresAt: string,
  url: string,
  purpose: ArtifactAccessPurpose,
) {
  const details =
    purpose === "share"
      ? {
          fileName: `artifact-${artifact.data.id}-share.json`,
          label: "Shared artifact",
          marker: "shared",
          summary: `Shared artifact ${artifact.data.name}.`,
        }
      : purpose === "provider-handoff"
        ? {
            fileName: `artifact-${artifact.data.id}-handoff.json`,
            label: "Prepared artifact handoff",
            marker: "providerHandoffPrepared",
            summary: `Prepared ${artifact.data.name} for provider handoff.`,
          }
        : {
            fileName: `artifact-${artifact.data.id}-inspect.json`,
            label: "Artifact access",
            marker: "accessPrepared",
            summary: `Prepared access to artifact ${artifact.data.name}.`,
          };
  return {
    ...jsonToolResult({
      fileName: details.fileName,
      label: details.label,
      summary: details.summary,
      value: {
        ...publicArtifact(artifact, purpose !== "share"),
        [details.marker]: true,
      },
    }),
    transientArtifacts: [transientArtifactAccess(artifact, expiresAt, url, purpose)],
  };
}
