import { describe, expect, test } from "bun:test";
import { S3Client, type ServiceOutputTypes } from "@aws-sdk/client-s3";
import { s3AppObjectStore } from "./s3-app-object-store.ts";

function fakeS3(outputs: ServiceOutputTypes[]) {
  const sent: Array<{ readonly command: string | undefined; readonly input: unknown }> = [];
  const client = new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    region: "us-east-1",
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      sent.push({ command: context.commandName, input: args.input });
      const output = outputs.shift();
      if (output === undefined) throw new Error(`No fake output left for ${context.commandName}.`);
      return { output, response: {} };
    },
    { priority: "high", step: "initialize" },
  );
  return { sent, store: s3AppObjectStore(client) };
}

describe("s3AppObjectStore", () => {
  test("lists one page of keys under the prefix", async () => {
    const s3 = fakeS3([
      {
        $metadata: {},
        Contents: [
          { Key: "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/exports/e1/orders.csv" },
          { Key: "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/releases/r1/index.html" },
        ],
      },
    ]);
    const keys = await s3.store.listObjects({
      bucket: "apps-bucket",
      prefix: "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/",
    });
    expect({ keys, sent: s3.sent }).toEqual({
      keys: [
        "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/exports/e1/orders.csv",
        "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/releases/r1/index.html",
      ],
      sent: [
        {
          command: "ListObjectsV2Command",
          input: {
            Bucket: "apps-bucket",
            MaxKeys: 1000,
            Prefix: "apps/01J9Z3NDEKTSV4RRFFQ69G5FAV/",
          },
        },
      ],
    });
  });

  test("deletes the keys in one quiet request", async () => {
    const s3 = fakeS3([{ $metadata: {} }]);
    await s3.store.deleteObjects({ bucket: "apps-bucket", keys: ["apps/A/one", "apps/A/two"] });
    expect(s3.sent).toEqual([
      {
        command: "DeleteObjectsCommand",
        input: {
          Bucket: "apps-bucket",
          Delete: { Objects: [{ Key: "apps/A/one" }, { Key: "apps/A/two" }], Quiet: true },
        },
      },
    ]);
  });

  test("rejects when S3 reports a key it did not delete", async () => {
    const s3 = fakeS3([
      {
        $metadata: {},
        Errors: [{ Code: "AccessDenied", Key: "apps/A/two", Message: "Access Denied" }],
      },
    ]);
    const failure = await s3.store
      .deleteObjects({ bucket: "apps-bucket", keys: ["apps/A/one", "apps/A/two"] })
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : error),
      );
    expect(failure).toBe(
      "S3 did not delete 1 of 2 objects from apps-bucket, first apps/A/two: AccessDenied Access Denied",
    );
  });
});
