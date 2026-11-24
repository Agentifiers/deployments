import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { exportQuery } from "../../data/governance-queries.ts";
import {
  OPERATION_LABELS,
  retryPath,
  type ExportKind,
  type FileFacts,
  type OperationView,
} from "../../governance/operation-state.ts";
import { formatExact } from "../../observability/format.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ExportDownloads, PhaseBadge } from "./operation-history.tsx";

function Fact({ children, term }: Readonly<{ children: ReactNode; term: string }>) {
  return (
    <>
      <DescriptionTerm>{term}</DescriptionTerm>
      <DescriptionDetails>{children}</DescriptionDetails>
    </>
  );
}

function FileFactsList({ file, term }: Readonly<{ file: FileFacts; term: string }>) {
  return (
    <Fact term={term}>
      <div className="flex flex-col gap-1">
        <Code>{file.fileName}</Code>
        <span className="text-sm/6 text-muted-foreground">
          {formatExact(file.sizeBytes)} bytes, SHA-256{" "}
          <Code className="break-all">{file.sha256}</Code>
        </span>
      </div>
    </Fact>
  );
}

function ArtifactFacts({ operation }: Readonly<{ operation: OperationView }>) {
  const { artifact } = operation;
  if (artifact === undefined) return null;
  switch (artifact.kind) {
    case "single_file":
    case "multipart_manifest":
      return (
        <>
          <FileFactsList
            file={artifact.file}
            term={artifact.kind === "single_file" ? "File" : "Manifest"}
          />
          {artifact.recordCount === undefined ? null : (
            <Fact term="Records">{formatExact(artifact.recordCount)}</Fact>
          )}
        </>
      );
    case "audit_bundle":
      return (
        <>
          <FileFactsList file={artifact.manifest} term="Signed manifest" />
          <FileFactsList file={artifact.archive} term="Records archive" />
          {artifact.recordCount === undefined ? null : (
            <Fact term="Audit events">{formatExact(artifact.recordCount)}</Fact>
          )}
          {artifact.rootHash === undefined ? null : (
            <Fact term="Chain root hash">
              <Code className="break-all">{artifact.rootHash}</Code>
            </Fact>
          )}
          {artifact.retainedUntil === undefined ? null : (
            <Fact term="Locked until">
              <Timestamp value={artifact.retainedUntil} />
            </Fact>
          )}
        </>
      );
  }
}

export function ExportDetail({
  kind,
  operationId,
  organizationId,
}: Readonly<{ kind: ExportKind; operationId: string; organizationId: string }>) {
  const { data: operation } = useSuspenseQuery(exportQuery(organizationId, kind, operationId));
  const { phase } = operation;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{OPERATION_LABELS[kind]}</Heading>
        <PhaseBadge phase={phase} />
      </div>
      {phase.status === "pending" || phase.status === "running" ? (
        <Text>This page refreshes every few seconds until the export finishes.</Text>
      ) : null}
      {phase.status === "failed" || (phase.status === "canceled" && phase.error) ? (
        <Callout variant="destructive">
          <CalloutTitle>
            {phase.status === "failed" ? "The export failed" : "The export was canceled"}
          </CalloutTitle>
          <CalloutDescription>
            <p>
              {phase.error?.message} <Code>{phase.error?.code}</Code>
            </p>
            {retryPath(operation) === "new_request" ? (
              <p>
                Start a new export from{" "}
                <Link
                  className="font-medium underline"
                  params={{ orgId: organizationId }}
                  to="/o/$orgId/governance"
                >
                  Data governance
                </Link>
                .
              </p>
            ) : null}
          </CalloutDescription>
        </Callout>
      ) : null}
      {operation.artifact?.kind === "multipart_manifest" ? (
        <Text>
          This export was too large for one file, so it was split into parts. The manifest lists
          them. Contact support to receive the parts.
        </Text>
      ) : null}
      {operation.artifact?.kind === "audit_bundle" ? (
        <Text>
          The manifest carries the chain&apos;s signature and public key. Verify the archive against
          it before relying on it.
        </Text>
      ) : null}
      <ExportDownloads kind={kind} operation={operation} organizationId={organizationId} />
      <DescriptionList>
        <Fact term="ID">
          <PublicId value={operation.id} />
        </Fact>
        <Fact term="Requested">
          <Timestamp value={operation.createdAt} />
        </Fact>
        {phase.status === "running" && phase.startedAt ? (
          <Fact term="Started">
            <Timestamp value={phase.startedAt} />
          </Fact>
        ) : null}
        {phase.status === "completed" ? (
          <Fact term="Finished">
            <Timestamp value={phase.completedAt} />
          </Fact>
        ) : null}
        <ArtifactFacts operation={operation} />
      </DescriptionList>
    </div>
  );
}
