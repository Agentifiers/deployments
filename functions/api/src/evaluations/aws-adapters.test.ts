import { describe, expect, test } from "bun:test";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { prepareCaseMaterial } from "@deployments-ai/observability/evaluators";
import { makeS3EvaluationArtifactStore, makeSqsEvaluationQueue } from "./aws-adapters.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5F00";
const DATASET = "01ARZ3NDEKTSV4RRFFQ69G5F01";
const KMS_KEY = "arn:aws:kms:us-east-1:123456789012:key/evaluations";

function fakeS3(handle: (command: unknown) => unknown) {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      return handle(command);
    },
  } as unknown as S3Client;
  return { client, commands };
}

describe("evaluation artifact store", () => {
  const prepared = prepareCaseMaterial({ content: "Can I get a refund?", expectations: {} });
  const material = {
    bytes: prepared.bytes,
    contentSha256: prepared.contentSha256,
    datasetId: DATASET,
    organizationId: ORG,
  };
  const checksum = Buffer.from(prepared.contentSha256, "hex").toString("base64");

  test("writes case material create-only, KMS-encrypted, and checksummed", async () => {
    const { client, commands } = fakeS3(() => ({ ETag: '"etag"', VersionId: "v1" }));
    const store = makeS3EvaluationArtifactStore({
      bucket: "artifacts",
      client,
      kmsKeyArn: KMS_KEY,
    });
    const reference = await store.putCaseMaterial(material);
    const put = commands[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: "artifacts",
      ChecksumSHA256: checksum,
      IfNoneMatch: "*",
      Key: `organizations/${ORG}/evaluation-cases/${DATASET}/${prepared.contentSha256}.json`,
      SSEKMSKeyId: KMS_KEY,
      ServerSideEncryption: "aws:kms",
    });
    expect(reference).toMatchObject({
      byteSize: prepared.bytes.byteLength,
      sha256: prepared.contentSha256,
      versionId: "v1",
    });
  });

  test("reuses an identical existing object and rejects a mismatched one", async () => {
    const existing = {
      ChecksumSHA256: checksum,
      ContentLength: prepared.bytes.byteLength,
      ContentType: "application/json",
      Metadata: { datasetid: DATASET, organizationid: ORG },
      SSEKMSKeyId: KMS_KEY,
      ServerSideEncryption: "aws:kms",
      VersionId: "v-existing",
    };
    const preconditionFailed = new Error("PreconditionFailed");
    const reused = fakeS3((command) => {
      if (command instanceof PutObjectCommand) throw preconditionFailed;
      return existing;
    });
    const reference = await makeS3EvaluationArtifactStore({
      bucket: "artifacts",
      client: reused.client,
      kmsKeyArn: KMS_KEY,
    }).putCaseMaterial(material);
    expect(reused.commands[1]).toBeInstanceOf(HeadObjectCommand);
    expect(reference.versionId).toBe("v-existing");

    const mismatched = fakeS3((command) => {
      if (command instanceof PutObjectCommand) throw preconditionFailed;
      return { ...existing, ChecksumSHA256: "different" };
    });
    expect(
      makeS3EvaluationArtifactStore({
        bucket: "artifacts",
        client: mismatched.client,
        kmsKeyArn: KMS_KEY,
      }).putCaseMaterial(material),
    ).rejects.toBe(preconditionFailed);
  });

  test("refuses to read stored content beyond the requested bound", async () => {
    const { client, commands } = fakeS3(() => ({}));
    const store = makeS3EvaluationArtifactStore({
      bucket: "artifacts",
      client,
      kmsKeyArn: KMS_KEY,
    });
    expect(
      store.readText(
        {
          bucket: "artifacts",
          byteSize: 2_048,
          contentType: "text/plain",
          key: "body",
          sha256: "x",
        },
        1_024,
      ),
    ).rejects.toMatchObject({ code: "evaluation_artifact_too_large" });
    expect(commands).toHaveLength(0);
  });
});

describe("evaluation queue", () => {
  test("sends FIFO messages with the message group and deduplication IDs", async () => {
    const commands: SendMessageCommand[] = [];
    const client = {
      send: async (command: SendMessageCommand) => {
        commands.push(command);
        return {};
      },
    } as unknown as SQSClient;
    await makeSqsEvaluationQueue({ client, queueUrl: "https://sqs.example/evaluations.fifo" }).send(
      {
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5F02",
        evaluationRunId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
        organizationId: ORG,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5F04",
        type: "evaluation-run.start",
      },
    );
    expect(commands[0]!.input).toMatchObject({
      MessageDeduplicationId: "start-01ARZ3NDEKTSV4RRFFQ69G5F03",
      MessageGroupId: "run-01ARZ3NDEKTSV4RRFFQ69G5F03",
      QueueUrl: "https://sqs.example/evaluations.fifo",
    });
    expect(JSON.parse(commands[0]!.input.MessageBody!)).toMatchObject({
      evaluationRunId: "01ARZ3NDEKTSV4RRFFQ69G5F03",
      type: "evaluation-run.start",
    });
  });
});
