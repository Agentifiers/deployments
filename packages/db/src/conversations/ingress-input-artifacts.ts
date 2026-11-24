import { INPUT_ARTIFACT_TYPE } from "@deployments-ai/agent-manifest";
import { Exit, Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import {
  ArtifactRecord,
  INGRESS_ATTACHMENT_OBJECT_NAME,
  ingressAttachmentObjectKey,
  type ArtifactInputFile,
} from "../records/artifacts.ts";
import type { IngressSource } from "../records/conversations.ts";
import {
  RecordDecodeError,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";

export type IngressInputArtifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;

export interface IngressInputArtifactScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export interface PendingIngressInputArtifact {
  readonly artifactId: Ulid;
  readonly name: string;
  readonly now: Date;
  readonly owner: IngressSource;
  readonly scope: IngressInputArtifactScope;
  readonly storage: {
    readonly bucket: string;
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly threadId: Ulid;
  readonly uploadExpiresAt: Date;
}

export interface StoredIngressInputArtifact {
  readonly etag?: string;
  readonly input: ArtifactInputFile;
  readonly now: Date;
  readonly retentionExpiresAt: Date;
  readonly versionId: string;
}

export interface IngressInputArtifactPersistence {
  find(
    scope: IngressInputArtifactScope,
    artifactId: Ulid,
  ): Promise<IngressInputArtifact | undefined>;
  createPending(input: PendingIngressInputArtifact): Promise<IngressInputArtifact>;
  markAvailable(
    pending: IngressInputArtifact,
    stored: StoredIngressInputArtifact,
  ): Promise<IngressInputArtifact>;
}

const CREATE_ONLY = "attribute_not_exists(pk) AND attribute_not_exists(sk)";

function artifactRecord(data: IngressInputArtifact["data"], expiresAt: Date) {
  const record = Schema.decodeUnknownExit(ArtifactRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "artifact",
      ttl: Math.floor(expiresAt.getTime() / 1_000),
    }),
  );
  if (Exit.isFailure(record)) {
    throw new RecordDecodeError({
      cause: record.cause,
      message: "The ingress input artifact does not form a valid record.",
    });
  }
  return record.value;
}

export function makeIngressInputArtifactPersistence(
  database: DynamoDatabaseService,
): IngressInputArtifactPersistence {
  async function find(scope: IngressInputArtifactScope, artifactId: Ulid) {
    const record = await database.getRecord(
      "execution",
      {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("ARTIFACT", artifactId),
      },
      true,
    );
    return record?.itemType === "artifact" ? record : undefined;
  }

  async function raced(scope: IngressInputArtifactScope, artifactId: Ulid, cause: unknown) {
    const current = await find(scope, artifactId);
    if (!current) throw cause;
    return current;
  }

  return {
    find,

    async createPending(input) {
      const timestamp = input.now.toISOString();
      const record = artifactRecord(
        {
          createdAt: timestamp,
          environmentId: input.scope.environmentId,
          id: input.artifactId,
          name: input.name,
          organizationId: input.scope.organizationId,
          owner: input.owner,
          projectId: input.scope.projectId,
          status: "pending",
          storage: {
            ...input.storage,
            contentType: "application/octet-stream",
            fileName: INGRESS_ATTACHMENT_OBJECT_NAME,
            key: ingressAttachmentObjectKey(input.scope, input.artifactId, input.storage.sha256),
          },
          threadId: input.threadId,
          type: INPUT_ARTIFACT_TYPE,
          updatedAt: timestamp,
          uploadExpiresAt: input.uploadExpiresAt.toISOString(),
          version: 0,
          visibility: "private",
        },
        input.uploadExpiresAt,
      );
      try {
        await database.putRecord(record, CREATE_ONLY);
        return record;
      } catch (cause) {
        return raced(input.scope, input.artifactId, cause);
      }
    },

    async markAvailable(pending, stored) {
      const { uploadExpiresAt: _uploadExpiresAt, ...data } = pending.data;
      const record = artifactRecord(
        {
          ...data,
          input: stored.input,
          retentionExpiresAt: stored.retentionExpiresAt.toISOString(),
          status: "available",
          storage: {
            ...pending.data.storage,
            ...(stored.etag ? { etag: stored.etag } : {}),
            versionId: stored.versionId,
          },
          updatedAt: stored.now.toISOString(),
          version: pending.data.version + 1,
        },
        stored.retentionExpiresAt,
      );
      try {
        await database.transactWrite([{ kind: "put", previousRecord: pending, record }]);
        return record;
      } catch (cause) {
        const current = await raced(pending.data, pending.data.id, cause);
        if (current.data.status !== "available") throw cause;
        return current;
      }
    },
  };
}
