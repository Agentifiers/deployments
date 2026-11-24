import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { BrainUploadTicketResponse } from "@deployments-ai/api-contract";
import {
  brainGrantPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  makeBrainUploadRepository,
  PersistenceError,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { makeDynamoDatabase } from "@deployments-ai/db/client";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
} from "@deployments-ai/db/dynamo-testing";
import { key } from "@deployments-ai/db/keys";
import { makeS3BrainContentUploader } from "./content-upload.ts";
import {
  brain,
  brainId,
  contentHash,
  invocation,
  organizationId,
  ownerGrant,
  principalId,
  repository,
  service,
  source,
  sourceId,
  timestamp,
} from "./service.fixture.ts";

const KMS_KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/content";
const TICKET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1";

interface StoredObject {
  readonly body: Uint8Array;
  readonly checksum: string | undefined;
  readonly contentType: string | undefined;
  readonly kmsKeyId: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly serverSideEncryption: string | undefined;
  readonly versionId: string;
}

function storageError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

/** Emulates the S3 behavior the upload paths depend on: checksums, create-only puts, and SigV4 query signing. */
function contentStorage() {
  const objects = new Map<string, StoredObject>();
  const store = (key: string, object: Omit<StoredObject, "versionId">, createOnly: boolean) => {
    if (createHash("sha256").update(object.body).digest("base64") !== object.checksum) {
      throw storageError("BadDigest");
    }
    if (createOnly && objects.has(key)) throw storageError("PreconditionFailed");
    const versionId = `s3-version-${objects.size + 1}`;
    objects.set(key, { ...object, versionId });
    return versionId;
  };
  const client = new S3Client({
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    region: "us-east-1",
  });
  client.send = (async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as Readable) chunks.push(Buffer.from(chunk));
      const versionId = store(
        command.input.Key!,
        {
          body: new Uint8Array(Buffer.concat(chunks)),
          checksum: command.input.ChecksumSHA256,
          contentType: command.input.ContentType,
          kmsKeyId: command.input.SSEKMSKeyId,
          metadata: command.input.Metadata ?? {},
          serverSideEncryption: command.input.ServerSideEncryption,
        },
        command.input.IfNoneMatch === "*",
      );
      return { ETag: '"etag"', VersionId: versionId };
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (!object) throw storageError("NotFound");
      return {
        ChecksumSHA256: object.checksum,
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        ETag: '"etag"',
        Metadata: object.metadata,
        SSEKMSKeyId: object.kmsKeyId,
        ServerSideEncryption: object.serverSideEncryption,
        VersionId: object.versionId,
      };
    }
    throw new Error("Unexpected S3 command.");
  }) as S3Client["send"];
  const putPresigned = (
    upload: { readonly headers: Readonly<Record<string, string>>; readonly url: string },
    body: Uint8Array,
  ) => {
    const url = new URL(upload.url);
    const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
    const sent = Object.keys(upload.headers);
    if (
      signed.some((name) => name !== "host" && !sent.includes(name)) ||
      sent.some((name) => !signed.includes(name))
    ) {
      throw storageError("SignatureDoesNotMatch");
    }
    if (Number(upload.headers["content-length"]) !== body.byteLength) {
      throw storageError("IncompleteBody");
    }
    store(
      decodeURIComponent(url.pathname.slice(1)),
      {
        body,
        checksum: upload.headers["x-amz-checksum-sha256"],
        contentType: upload.headers["content-type"],
        kmsKeyId: upload.headers["x-amz-server-side-encryption-aws-kms-key-id"],
        metadata: Object.fromEntries(
          [...url.searchParams]
            .filter(([name]) => name.startsWith("x-amz-meta-"))
            .map(([name, value]) => [name.slice("x-amz-meta-".length), value]),
        ),
        serverSideEncryption: upload.headers["x-amz-server-side-encryption"],
      },
      upload.headers["if-none-match"] === "*",
    );
  };
  return { client, objects, putPresigned };
}

function liveUploadStore() {
  const dynamo = fakeDynamoDocumentClient();
  for (const record of [
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "organization" as const,
    }),
    {
      data: { kind: "human", status: "active" },
      itemType: "principal",
      pk: key("PRINCIPAL", principalId),
      sk: key("PRINCIPAL", principalId),
    },
    {
      data: { status: "active" },
      itemType: "organization-member",
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-MEMBER", principalId),
    },
    brainPlatformRecord(brain),
    brainSourcePlatformRecord(source),
    brainGrantPlatformRecord(ownerGrant),
  ]) {
    dynamo.put("control", record);
  }
  const storage = contentStorage();
  const api = service(
    {
      contentBucket: "content-bucket",
      contentKmsKeyArn: KMS_KEY_ARN,
      contentUploader: makeS3BrainContentUploader(storage.client),
      repository: repository({
        ...makeBrainUploadRepository(makeDynamoDatabase(dynamo.client)),
        getSource: async () => source,
      }),
    },
    [TICKET_ID, ...Array.from({ length: 8 }, (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5FD${index}`)],
  );
  return { api, dynamo, storage };
}

function contentRequest() {
  return invocation({
    params: { brainId, sourceId, ticketId: TICKET_ID },
    rawRequest: new Request("https://api.example/upload", {
      body: "abc",
      headers: { "content-length": "3", "content-type": "text/plain" },
      method: "PUT",
    }),
  });
}

function completesUpload(input: TransactWriteCommandInput) {
  return (input.TransactItems ?? []).some(
    ({ Put }) =>
      Put?.Item?.itemType === "brain-upload-lease" && Put.Item.data?.status === "completed",
  );
}

describe("Brain upload content replay", () => {
  test("a resend after a cancelled completion completes the upload", async () => {
    const { api, dynamo, storage } = liveUploadStore();
    await api.invoke(
      "createBrainUploadTicket",
      invocation({
        body: { expectedByteSize: 3, expectedContentHash: contentHash, mediaType: "text/plain" },
        params: { brainId, sourceId },
      }),
    );
    let contended = true;
    const contend = () =>
      dynamo.failNextTransaction(
        (input) => contended && completesUpload(input),
        () => {
          contend();
          return transactionCanceledError(["None", "ThrottlingError", "TransactionConflict"]);
        },
      );
    contend();
    const cancelled = await api
      .invoke("uploadBrainContent", contentRequest())
      .then(() => "completed")
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    contended = false;

    const resent = await api.invoke("uploadBrainContent", contentRequest());
    const again = await api.invoke("uploadBrainContent", contentRequest());

    expect(cancelled).toBe("DynamoDB transact-write failed for table multiple.");
    expect(resent).toMatchObject({
      bodyRef: { byteSize: 3, sha256: contentHash, versionId: "s3-version-1" },
      id: TICKET_ID,
      status: "completed",
    });
    expect(again).toMatchObject({ id: TICKET_ID, status: "completed", version: 2 });
    expect([...storage.objects.values()].map(({ versionId }) => versionId)).toEqual([
      "s3-version-1",
    ]);
  });
});

describe("Brain direct upload", () => {
  test("stores an 8 MiB file through the presigned PUT and completes the ticket", async () => {
    const { api, storage } = liveUploadStore();
    const bytes = new Uint8Array(8 * 1024 * 1024).fill(0x25);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const ticketPath = `/v1/brains/${brainId}/sources/${sourceId}/uploads/${TICKET_ID}`;
    const issued = await api.invoke(
      "createBrainUploadTicket",
      invocation({
        body: {
          expectedByteSize: bytes.byteLength,
          expectedContentHash: hash,
          mediaType: "application/pdf",
        },
        params: { brainId, sourceId },
      }),
    );
    const directUpload = Schema.decodeUnknownSync(BrainUploadTicketResponse)(issued).directUpload!;
    const complete = () =>
      api
        .invoke(
          "completeBrainUpload",
          invocation({ params: { brainId, sourceId, ticketId: TICKET_ID } }),
        )
        .catch((error: unknown) =>
          error instanceof PersistenceError ? error.code : String(error),
        );

    const beforeStorage = await complete();
    storage.putPresigned(directUpload, bytes);
    const completed = await complete();
    const replayed = await complete();

    expect(issued).toMatchObject({
      directUpload: {
        completePath: `${ticketPath}/complete`,
        expiresAt: "2026-07-30T12:05:00.000Z",
        headers: { "content-length": "8388608", "content-type": "application/pdf" },
        method: "PUT",
      },
      uploadPath: `${ticketPath}/content`,
    });
    expect(beforeStorage).toBe("brain_upload_content_missing");
    expect(completed).toMatchObject({
      bodyRef: { byteSize: 8_388_608, sha256: hash, versionId: "s3-version-1" },
      status: "completed",
    });
    expect(replayed).toEqual(completed);
  });
});
