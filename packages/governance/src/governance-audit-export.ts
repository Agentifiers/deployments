import { canonicalJson, hashChain, ordinalCompare, sha256Bytes } from "./canonical.ts";
import type { AuditArchiveState, GovernanceServiceContext } from "./service.ts";
import { MAX_EXPORT_BYTES, encoder, immutableRetainUntil, inspectAuditArchive } from "./service.ts";
import { GovernanceError, type GovernanceOperation, type TenantRecord } from "./types.ts";

export function makeGovernanceAuditExport(context: GovernanceServiceContext) {
  const { getOperation: _getOperation, getRetentionPolicy, now, options, writeObject } = context;
  return async (
    initial: GovernanceOperation,
    records: readonly TenantRecord[],
    operationUpdated: (operation: GovernanceOperation) => void,
    snapshotCaptured: () => Promise<void>,
  ) => {
    let current = initial;
    const createdAt = current.startedAt ?? current.createdAt;
    const signatureCheckpointFields = [
      current.auditSignature,
      current.auditSignatureKeyId,
      current.auditSignaturePublicKey,
    ].filter((value) => value !== undefined).length;
    if (
      signatureCheckpointFields !== 0 &&
      (signatureCheckpointFields !== 3 || !current.auditRetainedUntil)
    ) {
      throw new GovernanceError(
        "audit_export_retry_mismatch",
        "The persisted audit signature checkpoint is incomplete.",
      );
    }
    const retainedUntil =
      current.auditRetainedUntil ??
      immutableRetainUntil(
        new Date(createdAt),
        (await getRetentionPolicy(current.organizationId)).audit,
      );
    if (!current.auditRetainedUntil) {
      current = await options.store.updateOperation(
        {
          ...current,
          auditRetainedUntil: retainedUntil,
          updatedAt: now().toISOString(),
          version: current.version + 1,
        },
        current.version,
      );
      operationUpdated(current);
    }

    const archiveKey = `governance/${current.organizationId}/${current.id}/audit-records.jsonl`;
    let archive = current.archive ?? (await options.objectStore.find(archiveKey));
    let archiveState: AuditArchiveState;
    if (archive) {
      archiveState = inspectAuditArchive(
        archive,
        await options.objectStore.read(archive),
        current.organizationId,
      );
    } else {
      const events = records
        .filter((item) => item.record.itemType === "audit-event")
        .map((item) => item.record)
        .filter(
          (event) =>
            ordinalCompare((event.data as { occurredAt: string }).occurredAt, createdAt) <= 0,
        )
        .sort((left, right) => {
          const leftData = left.data as { occurredAt: string; eventId: string };
          const rightData = right.data as { occurredAt: string; eventId: string };
          return (
            ordinalCompare(leftData.occurredAt, rightData.occurredAt) ||
            ordinalCompare(leftData.eventId, rightData.eventId)
          );
        });
      const chain = hashChain(events);
      const archiveLines: string[] = [];
      let archiveBytes = 0;
      for (const entry of chain.entries) {
        const line = canonicalJson(entry);
        archiveBytes += encoder.encode(line).byteLength + 1;
        if (archiveBytes > MAX_EXPORT_BYTES) {
          throw new GovernanceError(
            "audit_export_too_large",
            `Governance export bodies cannot exceed ${MAX_EXPORT_BYTES} bytes.`,
          );
        }
        archiveLines.push(line);
      }
      const body = encoder.encode(archiveLines.length === 0 ? "" : `${archiveLines.join("\n")}\n`);
      archive = await writeObject(
        current.organizationId,
        current.id,
        "audit-records.jsonl",
        body,
        "application/x-ndjson",
        true,
        retainedUntil,
      );
      archiveState = {
        ...(events[0]
          ? { firstEventAt: (events[0].data as { occurredAt: string }).occurredAt }
          : {}),
        ...(events.at(-1)
          ? { lastEventAt: (events.at(-1)!.data as { occurredAt: string }).occurredAt }
          : {}),
        recordCount: events.length,
        rootHash: chain.rootHash,
      };
    }
    if (!current.archive) {
      current = await options.store.updateOperation(
        {
          ...current,
          archive,
          updatedAt: now().toISOString(),
          version: current.version + 1,
        },
        current.version,
      );
      operationUpdated(current);
    }
    await snapshotCaptured();
    const header = {
      algorithm: "sha256-chain-v1",
      createdAt,
      organizationId: current.organizationId,
      recordCount: archiveState.recordCount,
      rootHash: archiveState.rootHash,
    };
    const signatureKeyId = current.auditSignatureKeyId ?? options.signer.keyId;
    const signaturePublicKey =
      current.auditSignaturePublicKey ?? (await options.signer.publicKey());
    const unsignedManifest = {
      ...header,
      archive,
      canonicalization: "canonical-json-v1",
      retainedUntil,
      signatureKeyId,
      signaturePublicKey,
    };
    let signature = current.auditSignature;
    if (!signature) {
      signature = await options.signer.sign(sha256Bytes(canonicalJson(unsignedManifest)));
      current = await options.store.updateOperation(
        {
          ...current,
          auditSignature: signature,
          auditSignatureKeyId: signatureKeyId,
          auditSignaturePublicKey: signaturePublicKey,
          updatedAt: now().toISOString(),
          version: current.version + 1,
        },
        current.version,
      );
      operationUpdated(current);
    }
    const manifestBody = encoder.encode(`${canonicalJson({ ...unsignedManifest, signature })}\n`);
    const object = await writeObject(
      current.organizationId,
      current.id,
      "audit-manifest.json",
      manifestBody,
      "application/json",
      true,
      retainedUntil,
    );
    if (!current.output) {
      current = await options.store.updateOperation(
        {
          ...current,
          output: object,
          updatedAt: now().toISOString(),
          version: current.version + 1,
        },
        current.version,
      );
      operationUpdated(current);
    }
    await options.store.appendImmutableAuditExport(
      {
        algorithm: "sha256-chain-v1",
        archive,
        createdAt: header.createdAt,
        createdByPrincipalId: current.requestedByPrincipalId,
        ...(archiveState.firstEventAt ? { firstEventAt: archiveState.firstEventAt } : {}),
        id: current.id,
        ...(archiveState.lastEventAt ? { lastEventAt: archiveState.lastEventAt } : {}),
        object,
        organizationId: current.organizationId,
        recordCount: archiveState.recordCount,
        retainedUntil,
        rootHash: archiveState.rootHash,
        signature,
        signatureKeyId,
        signaturePublicKey,
      },
      current,
      now().toISOString(),
    );
    return {
      archive,
      object,
      summary: {
        archiveSha256: archive.sha256,
        manifestSha256: object.sha256,
        recordCount: archiveState.recordCount,
        retainedUntil,
        rootHash: archiveState.rootHash,
      },
    };
  };
}
