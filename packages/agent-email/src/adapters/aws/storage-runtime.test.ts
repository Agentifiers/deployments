import { describe, expect, it } from "bun:test";
import type { SESv2Client } from "@aws-sdk/client-sesv2";
import { DeleteObjectsCommand, GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  externalizeInboundAgentEmailBodies,
  makeAgentEmailAwsRuntime,
  prepareAgentEmailSend,
} from "./runtime.ts";

describe("agent email S3 storage runtime", () => {
  it("reads and deletes retained legacy objects while rejecting unknown buckets", async () => {
    const commands: unknown[] = [];
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "current-agent-email",
        configurationSetName: "agent-email",
        eventsQueueUrl: "https://sqs.example/events",
        legacyBuckets: ["legacy-agent-email"],
        region: "us-east-2",
        sendQueueUrl: "https://sqs.example/send",
      },
      {
        s3: {
          send: async (command: unknown) => {
            commands.push(command);
            return command instanceof GetObjectCommand
              ? { Body: { transformToByteArray: async () => new Uint8Array([1]) } }
              : {};
          },
        } as S3Client,
      },
    );

    expect(runtime.blobs.get("raw/message", "version", "legacy-agent-email")).resolves.toEqual(
      new Uint8Array([1]),
    );
    await runtime.blobs.delete("raw/message", "legacy-agent-email", "version");
    expect((commands[0] as GetObjectCommand).input.Bucket).toBe("legacy-agent-email");
    expect((commands[1] as DeleteObjectsCommand).input.Bucket).toBe("legacy-agent-email");
    expect(runtime.blobs.get("raw/message", "version", "unknown-bucket")).rejects.toThrow(
      "approved storage buckets",
    );
  });

  it("externalizes bodies above the DynamoDB inline threshold", async () => {
    const puts: string[] = [];
    const result = await externalizeInboundAgentEmailBodies(
      {
        attachments: [],
        bccAddresses: [],
        ccAddresses: [],
        fromAddress: "sender@example.com",
        subject: "Large",
        textBody: "x".repeat(300 * 1024),
        threadKey: "thread",
        toAddresses: ["agent@agents.example.com"],
        references: [],
        replyToAddresses: [],
      },
      {
        blobs: {
          delete: async () => {},
          get: async () => new Uint8Array(),
          put: async ({ key }) => {
            puts.push(key);
            return { created: true, etag: "body-etag", versionId: "body-version" };
          },
          signedGetUrl: async () => "https://example.invalid",
        },
        attemptId: "successful-upload",
        bucket: "agent-email",
        keyPrefix: "bodies/message-1",
      },
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(/^bodies\/message-1\/attempts\/[a-f0-9]{24}\/body\.txt$/u);
    expect(result.parsed).not.toHaveProperty("textBody");
    expect(result.bodyReferences.textBodyRef?.byteSize).toBe(300 * 1024);
    expect(result.bodyReferences.textBodyRef).toMatchObject({
      etag: "body-etag",
      versionId: "body-version",
    });
  });

  it("purges a successful body upload when its sibling upload fails", async () => {
    const deleted: {
      readonly bucket?: string;
      readonly key: string;
      readonly versionId?: string;
    }[] = [];
    expect(
      externalizeInboundAgentEmailBodies(
        {
          attachments: [],
          bccAddresses: [],
          ccAddresses: [],
          fromAddress: "sender@example.com",
          htmlBody: "x".repeat(200 * 1024),
          references: [],
          replyToAddresses: [],
          subject: "Large",
          textBody: "y".repeat(200 * 1024),
          threadKey: "thread",
          toAddresses: ["agent@agents.example.com"],
        },
        {
          blobs: {
            delete: async (key, bucket, versionId) => {
              deleted.push({
                ...(bucket ? { bucket } : {}),
                key,
                ...(versionId ? { versionId } : {}),
              });
            },
            get: async () => new Uint8Array(),
            put: async ({ key }) => {
              if (key.endsWith("body.txt")) throw new Error("text upload failed");
              return { created: true, versionId: "html-version" };
            },
            signedGetUrl: async () => "https://example.invalid",
          },
          attemptId: "failed-upload",
          bucket: "agent-email",
          keyPrefix: "bodies/message-2",
        },
      ),
    ).rejects.toThrow("text upload failed");
    expect(deleted).toEqual([
      {
        bucket: "agent-email",
        key: expect.stringMatching(/^bodies\/message-2\/attempts\/[a-f0-9]{24}\/body\.html$/u),
        versionId: "html-version",
      },
    ]);
  });

  it("does not purge a reused body version when its sibling upload fails", async () => {
    const deleted: string[] = [];
    expect(
      externalizeInboundAgentEmailBodies(
        {
          attachments: [],
          bccAddresses: [],
          ccAddresses: [],
          fromAddress: "sender@example.com",
          htmlBody: "x".repeat(200 * 1024),
          references: [],
          replyToAddresses: [],
          subject: "Large",
          textBody: "y".repeat(200 * 1024),
          threadKey: "thread",
          toAddresses: ["agent@agents.example.com"],
        },
        {
          blobs: {
            delete: async (key) => {
              deleted.push(key);
            },
            get: async () => new Uint8Array(),
            put: async ({ key }) => {
              if (key.endsWith("body.txt")) throw new Error("text upload failed");
              return { created: false, versionId: "committed-html-version" };
            },
            signedGetUrl: async () => "https://example.invalid",
          },
          attemptId: "ambiguous-retry",
          bucket: "agent-email",
          keyPrefix: "bodies/message-ambiguous",
        },
      ),
    ).rejects.toThrow("text upload failed");
    expect(deleted).toEqual([]);
  });

  it("reuses a deterministic body prefix when an attempt ID is retried", async () => {
    const keys: string[] = [];
    const blobs = {
      delete: async () => {},
      get: async () => new Uint8Array(),
      put: async ({ key }: { readonly key: string }) => {
        keys.push(key);
      },
      signedGetUrl: async () => "https://example.invalid",
    };
    const parsed = {
      attachments: [],
      bccAddresses: [],
      ccAddresses: [],
      fromAddress: "sender@example.com",
      references: [],
      replyToAddresses: [],
      subject: "Large",
      textBody: "x".repeat(300 * 1024),
      threadKey: "thread",
      toAddresses: ["agent@agents.example.com"],
    };

    await externalizeInboundAgentEmailBodies(parsed, {
      attemptId: "reused-attempt",
      blobs,
      bucket: "agent-email",
      keyPrefix: "bodies/message-retry",
    });
    await externalizeInboundAgentEmailBodies(parsed, {
      attemptId: "reused-attempt",
      blobs,
      bucket: "agent-email",
      keyPrefix: "bodies/message-retry",
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("loads persisted attachments and sends through the configured global endpoint", async () => {
    const commands: { readonly input?: unknown }[] = [];
    const ses = {
      send: async (command: { readonly input?: unknown }) => {
        commands.push(command);
        return { MessageId: "ses-message" };
      },
    } as unknown as SESv2Client;
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "agent-email",
        configurationSetName: "agent-email",
        endpointId: "global-endpoint",
        eventsQueueUrl: "https://sqs.example/events",
        loadAttachment: async () => new TextEncoder().encode("attachment"),
        region: "us-east-1",
        sendQueueUrl: "https://sqs.example/send",
        tenantName: "agent-inboxes-tenant",
      },
      { ses },
    );
    await runtime.outbound.send({
      attachments: [
        {
          byteSize: 10,
          contentId: "c".repeat(78),
          contentType: "text/plain; charset=utf-8",
          disposition: "attachment",
          fileName: "note.txt",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          sha256: "hash",
        },
      ],
      bccAddresses: [],
      ccAddresses: [],
      createdAt: "2026-07-20T00:00:00.000Z",
      direction: "outbound",
      fromAddress: "agent@agents.example.com",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      reprocessCount: 0,
      references: [],
      replyToAddresses: [],
      status: "queued",
      subject: "Hello",
      textBody: "Hello",
      threadKey: "thread",
      toAddresses: ["recipient@example.com"],
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const input = commands[0]?.input as {
      readonly Content?: { readonly Simple?: { readonly Attachments?: readonly unknown[] } };
      readonly EndpointId?: string;
    };
    expect(input.EndpointId).toBe("global-endpoint");
    expect(input.Content?.Simple?.Attachments).toHaveLength(1);
    const attachment = input.Content?.Simple?.Attachments?.[0] as
      | { readonly ContentId?: string; readonly ContentType?: string }
      | undefined;
    expect(attachment?.ContentId).toBe("c".repeat(78));
    expect(attachment?.ContentType).toBe("text/plain; charset=utf-8");
  });

  it("rejects unsafe attachment Content-ID values instead of rewriting them", () => {
    const baseAttachment = {
      byteSize: 10,
      contentType: "text/plain",
      disposition: "inline" as const,
      fileName: "note.txt",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      sha256: "hash",
      content: new TextEncoder().encode("attachment"),
    };
    const message = {
      attachments: [],
      bccAddresses: [],
      ccAddresses: [],
      createdAt: "2026-07-20T00:00:00.000Z",
      direction: "outbound" as const,
      fromAddress: "agent@agents.example.com",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      reprocessCount: 0,
      references: [],
      replyToAddresses: [],
      status: "queued" as const,
      subject: "Hello",
      textBody: "Hello",
      threadKey: "thread",
      toAddresses: ["recipient@example.com"],
      updatedAt: "2026-07-20T00:00:00.000Z",
    };

    expect(() =>
      prepareAgentEmailSend({
        attachments: [{ ...baseAttachment, contentId: "unsafe\r\nvalue" }],
        configurationSetName: "agent-email",
        message,
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("must not contain line breaks");
    expect(() =>
      prepareAgentEmailSend({
        attachments: [{ ...baseAttachment, contentId: "c".repeat(79) }],
        configurationSetName: "agent-email",
        message,
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("78-character limit");
    expect(() =>
      prepareAgentEmailSend({
        attachments: [{ ...baseAttachment, fileName: "f".repeat(256) }],
        configurationSetName: "agent-email",
        message,
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("between 1 and 255 characters");
    expect(() =>
      prepareAgentEmailSend({
        attachments: [{ ...baseAttachment, contentType: "text/plain\r\nX-Injected: true" }],
        configurationSetName: "agent-email",
        message,
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("Content-Type must not contain line breaks");
    expect(() =>
      prepareAgentEmailSend({
        attachments: [{ ...baseAttachment, contentType: `text/plain;${"x".repeat(80)}` }],
        configurationSetName: "agent-email",
        message,
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("78-character limit");
  });

  it("purges every concrete version and delete marker for a blob", async () => {
    const deleted: readonly { readonly Key?: string; readonly VersionId?: string }[][] = [];
    const mutableDeleted = deleted as { readonly Key?: string; readonly VersionId?: string }[][];
    const s3 = {
      send: async (command: {
        readonly input?: {
          readonly Delete?: {
            readonly Objects?: readonly { readonly Key?: string; readonly VersionId?: string }[];
          };
        };
      }) => {
        if (command.constructor.name === "ListObjectVersionsCommand") {
          return {
            DeleteMarkers: [{ Key: "raw/message", VersionId: "marker-1" }],
            IsTruncated: false,
            Versions: [
              { Key: "raw/message", VersionId: "version-1" },
              { Key: "raw/message-other", VersionId: "other-version" },
            ],
          };
        }
        mutableDeleted.push([...(command.input?.Delete?.Objects ?? [])]);
        return {};
      },
    } as unknown as S3Client;
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "agent-email",
        configurationSetName: "agent-email",
        eventsQueueUrl: "https://sqs.example/events",
        region: "us-east-1",
        sendQueueUrl: "https://sqs.example/send",
        tenantName: "agent-inboxes-tenant",
      },
      { s3 },
    );

    await runtime.blobs.delete("raw/message");

    expect(deleted).toEqual([
      [
        { Key: "raw/message", VersionId: "version-1" },
        { Key: "raw/message", VersionId: "marker-1" },
      ],
    ]);
  });

  it("returns S3 write versions and reads the persisted version", async () => {
    const inputs: { readonly Key?: string; readonly VersionId?: string }[] = [];
    const s3 = {
      send: async (command: {
        readonly input?: { readonly Key?: string; readonly VersionId?: string };
      }) => {
        inputs.push(command.input ?? {});
        if (command.constructor.name === "PutObjectCommand") {
          return { ETag: "stored-etag", VersionId: "stored-version" };
        }
        return {
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
        };
      },
    } as unknown as S3Client;
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "agent-email",
        configurationSetName: "agent-email",
        eventsQueueUrl: "https://sqs.example/events",
        region: "us-east-1",
        sendQueueUrl: "https://sqs.example/send",
        tenantName: "agent-inboxes-tenant",
      },
      { s3 },
    );

    const stored = await runtime.blobs.put({
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      key: "bodies/message/body.bin",
    });
    await runtime.blobs.get("bodies/message/body.bin", "stored-version");

    expect(stored).toEqual({ created: true, etag: "stored-etag", versionId: "stored-version" });
    expect(inputs.at(-1)).toMatchObject({
      Key: "bodies/message/body.bin",
      VersionId: "stored-version",
    });
  });

  it("reuses an existing matching S3 version for conditional retry writes", async () => {
    const commands: { readonly input?: Record<string, unknown>; readonly name: string }[] = [];
    let putAttempts = 0;
    const s3 = {
      send: async (command: { readonly input?: Record<string, unknown> }) => {
        commands.push({
          ...(command.input ? { input: command.input } : {}),
          name: command.constructor.name,
        });
        if (command.constructor.name === "PutObjectCommand") {
          putAttempts += 1;
          if (putAttempts === 1) return { ETag: "stored-etag", VersionId: "stored-version" };
          const cause = new Error("already stored");
          cause.name = "PreconditionFailed";
          throw cause;
        }
        if (command.constructor.name === "HeadObjectCommand") {
          return {
            ContentLength: 3,
            ContentType: "application/octet-stream",
            ETag: "stored-etag",
            Metadata: { sha256: "stored-hash" },
            VersionId: "stored-version",
          };
        }
        throw new Error(`Unexpected command ${command.constructor.name}.`);
      },
    } as unknown as S3Client;
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "agent-email",
        configurationSetName: "agent-email",
        eventsQueueUrl: "https://sqs.example/events",
        region: "us-east-1",
        sendQueueUrl: "https://sqs.example/send",
        tenantName: "agent-inboxes-tenant",
      },
      { s3 },
    );
    const input = {
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      ifAbsent: true,
      key: "bodies/message/attempts/retry/body.bin",
      metadata: { sha256: "stored-hash" },
    };

    const first = await runtime.blobs.put(input);
    const retry = await runtime.blobs.put(input);

    expect(first).toEqual({ created: true, etag: "stored-etag", versionId: "stored-version" });
    expect(retry).toEqual({ created: false, etag: "stored-etag", versionId: "stored-version" });
    expect(commands.filter((command) => command.name === "PutObjectCommand")).toHaveLength(2);
    expect(commands.filter((command) => command.name === "HeadObjectCommand")).toHaveLength(1);
    expect(
      commands
        .filter((command) => command.name === "PutObjectCommand")
        .every((command) => command.input?.IfNoneMatch === "*"),
    ).toBeTrue();
  });

  it("fails a purge when S3 reports per-version deletion errors", async () => {
    const s3 = {
      send: async (command: object) =>
        command.constructor.name === "ListObjectVersionsCommand"
          ? {
              IsTruncated: false,
              Versions: [{ Key: "raw/message", VersionId: "version-1" }],
            }
          : { Errors: [{ Key: "raw/message", VersionId: "version-1" }] },
    } as unknown as S3Client;
    const runtime = makeAgentEmailAwsRuntime(
      {
        bucket: "agent-email",
        configurationSetName: "agent-email",
        eventsQueueUrl: "https://sqs.example/events",
        region: "us-east-1",
        sendQueueUrl: "https://sqs.example/send",
        tenantName: "agent-inboxes-tenant",
      },
      { s3 },
    );

    expect(runtime.blobs.delete("raw/message")).rejects.toThrow(
      "S3 failed to delete 1 versioned agent email objects.",
    );
  });
});
