import {
  HeadObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  HostedCodeArtifactConflictError,
  makeHostedCodeArtifactPersistence,
  PersistenceError,
  type HostedCodeArtifact,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { transform } from "sucrase";
import type { AdministrationInvocation } from "./administration-api.ts";
import { asObject, id, text } from "./administration-persistence-contracts.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence-context.ts";

export interface HostedCodeArtifactObjectInput {
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly environmentId: string;
  readonly key: string;
  readonly organizationId: string;
}

/** Stores immutable executable bytes; returns the object's bucket and version. */
export interface HostedCodeArtifactObjectStore {
  readonly put: (
    input: HostedCodeArtifactObjectInput,
  ) => Promise<{ readonly bucket: string; readonly versionId: string }>;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest();
}

export function makeS3HostedCodeArtifactObjectStore(options: {
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly kmsKeyArn: string;
}): HostedCodeArtifactObjectStore {
  return {
    async put(input) {
      const checksum = Buffer.from(input.contentHash.replace(/^sha256:/u, ""), "hex").toString(
        "base64",
      );
      const metadata = {
        contenthash: input.contentHash,
        environmentid: input.environmentId,
        organizationid: input.organizationId,
      };
      try {
        const result = await options.client.send(
          new PutObjectCommand({
            Body: input.bytes,
            Bucket: options.bucket,
            ChecksumSHA256: checksum,
            ContentLength: input.bytes.byteLength,
            ContentType: "text/plain; charset=utf-8",
            IfNoneMatch: "*",
            Key: input.key,
            Metadata: metadata,
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: options.kmsKeyArn,
          }),
        );
        if (!result.VersionId) {
          throw new Error("Hosted code artifact storage did not return an immutable version ID.");
        }
        return { bucket: options.bucket, versionId: result.VersionId };
      } catch (cause) {
        // A retried upload of the same content finds the create-only object already written.
        let head: HeadObjectCommandOutput;
        try {
          head = await options.client.send(
            new HeadObjectCommand({
              Bucket: options.bucket,
              ChecksumMode: "ENABLED",
              Key: input.key,
            }),
          );
        } catch {
          throw cause;
        }
        if (
          !head.VersionId ||
          head.ContentLength !== input.bytes.byteLength ||
          head.ChecksumSHA256 !== checksum ||
          head.ServerSideEncryption !== "aws:kms" ||
          head.SSEKMSKeyId !== options.kmsKeyArn ||
          head.Metadata?.organizationid !== input.organizationId ||
          head.Metadata.environmentid !== input.environmentId ||
          head.Metadata.contenthash !== input.contentHash
        ) {
          throw cause;
        }
        return { bucket: options.bucket, versionId: head.VersionId };
      }
    },
  };
}

type SourceLanguage = "javascript" | "python" | "typescript";

/**
 * Upload-time compilation: TypeScript is stripped to ES module JavaScript here so the worker only
 * ever executes JavaScript or Python. JavaScript is parsed to reject syntax errors early.
 */
function compileHostedCodeSource(language: SourceLanguage, source: string) {
  if (language === "python") return { code: source, language: "python" as const };
  try {
    const { code } = transform(source, {
      disableESTransforms: true,
      transforms: language === "typescript" ? ["typescript"] : [],
    });
    return { code, language: "javascript" as const };
  } catch (cause) {
    throw new PersistenceError(
      "unprocessable",
      "hosted_code_compile_failed",
      `Hosted code ${language} source could not be compiled: ${
        cause instanceof Error ? cause.message : "syntax error"
      }`,
    );
  }
}

function artifactProjection(artifact: HostedCodeArtifact) {
  return {
    byteSize: artifact.data.byteSize,
    contentHash: artifact.data.contentHash,
    createdAt: artifact.data.createdAt,
    language: artifact.data.language,
    sourceByteSize: artifact.data.sourceByteSize,
    sourceContentHash: artifact.data.sourceContentHash,
    sourceLanguage: artifact.data.sourceLanguage,
  };
}

export function makeHostedCodeArtifactAdministration(context: AdministrationPersistenceContext) {
  const { databaseValue, dependencies, environment, now } = context;
  const persistence = makeHostedCodeArtifactPersistence(dependencies.database);

  async function createHostedCodeArtifact(invocation: AdministrationInvocation) {
    const store = dependencies.hostedCodeArtifacts;
    if (!store) {
      throw new PersistenceError(
        "internal",
        "hosted_code_storage_unconfigured",
        "Hosted code artifact storage is not configured.",
      );
    }
    const principalId = invocation.identity?.principalId;
    if (!principalId) {
      throw new PersistenceError("forbidden", "principal_required", "A principal is required.");
    }
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const sourceLanguage = text(body.language, "language") as SourceLanguage;
    const source = typeof body.source === "string" ? body.source : text(body.source, "source");
    const compiled = compileHostedCodeSource(sourceLanguage, source);
    const sourceBytes = new TextEncoder().encode(source);
    const bytes = new TextEncoder().encode(compiled.code);
    const hex = sha256(bytes).toString("hex");
    const contentHash = `sha256:${hex}`;
    const artifactKey = {
      contentHash,
      environmentId: scope.id,
      organizationId: scope.organizationId,
    };
    const existing = await databaseValue(persistence.load(artifactKey));
    if (existing && existing.data.sourceLanguage === sourceLanguage) {
      return artifactProjection(existing);
    }
    const objectKey = `organizations/${scope.organizationId}/hosted-code-artifacts/projects/${scope.projectId}/environments/${scope.id}/${hex}.${compiled.language === "python" ? "py" : "mjs"}`;
    const stored = await store.put({ ...artifactKey, bytes, key: objectKey });
    const created = persistence
      .create({
        byteSize: bytes.byteLength,
        contentHash,
        createdAt: now().toISOString(),
        createdByPrincipalId: id(principalId),
        environmentId: scope.id,
        language: compiled.language,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        sourceByteSize: sourceBytes.byteLength,
        sourceContentHash: `sha256:${sha256(sourceBytes).toString("hex")}`,
        sourceLanguage,
        storage: {
          bucket: stored.bucket,
          byteSize: bytes.byteLength,
          key: objectKey,
          versionId: stored.versionId,
        },
      })
      .catch((cause: unknown) => {
        if (cause instanceof HostedCodeArtifactConflictError) {
          throw new PersistenceError("conflict", "hosted_code_artifact_conflict", cause.message);
        }
        throw cause;
      });
    return artifactProjection(await databaseValue(created));
  }

  async function getHostedCodeArtifact(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const contentHash = text(invocation.params.contentHash, "contentHash");
    const artifact = await databaseValue(
      persistence.load({
        contentHash,
        environmentId: scope.id,
        organizationId: scope.organizationId,
      }),
    );
    if (!artifact || artifact.data.projectId !== scope.projectId) {
      throw new PersistenceError(
        "not-found",
        "resource_not_found",
        "Hosted code artifact was not found.",
      );
    }
    return artifactProjection(artifact);
  }

  return { createHostedCodeArtifact, getHostedCodeArtifact };
}
