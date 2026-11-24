import { afterAll, describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { ReleaseDocumentPath } from "@deployments-ai/db";
import { Schema } from "effect";
import { s3ReleaseFiles } from "./aws.ts";
import { id } from "./test-support.ts";

const APP = id("01ARZ3NDEKTSV4RRFFQ69G5FC0");
const RELEASE = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
const document = Schema.decodeUnknownSync(ReleaseDocumentPath);

const requested: string[] = [];
const storage = Bun.serve({
  fetch(request) {
    const { pathname } = new URL(request.url);
    requested.push(pathname);
    return pathname === `/releases/apps/${APP}/releases/${RELEASE}/about/index.html`
      ? new Response("<h1>About</h1>")
      : new Response(
          "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
          { headers: { "content-type": "application/xml" }, status: 404 },
        );
  },
  port: 0,
});

afterAll(() => storage.stop(true));

describe("s3ReleaseFiles", () => {
  test("reads a document under its release prefix and answers a missing one with undefined", async () => {
    const files = s3ReleaseFiles({
      bucket: "releases",
      client: new S3Client({
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        endpoint: `http://127.0.0.1:${storage.port}`,
        forcePathStyle: true,
        region: "us-east-1",
      }),
    });

    const read = (path: string) =>
      files.document({ appId: APP, document: document(path), releaseId: RELEASE });

    expect({
      found: await read("about/index.html"),
      missing: await read("schedule.html"),
      requested,
    }).toEqual({
      found: "<h1>About</h1>",
      missing: undefined,
      requested: [
        `/releases/apps/${APP}/releases/${RELEASE}/about/index.html`,
        `/releases/apps/${APP}/releases/${RELEASE}/schedule.html`,
      ],
    });
  });
});
