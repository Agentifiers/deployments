import { MessageRecord, RunRecord, withCanonicalRecordKeys, type Ulid } from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { type AgentRunMessageBodyWrite } from "./types.ts";

export const id = (value: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G${String(value).padStart(4, "0")}` as Ulid;
export const KMS_KEY_ARN =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";

export function messageBodyKey(
  digest: string,
  options: {
    readonly organizationId?: Ulid;
    readonly prefix?: string;
  } = {},
): string {
  return `${options.prefix ?? "message-bodies"}/organizations/${options.organizationId ?? id(1)}/projects/${id(2)}/environments/${id(3)}/threads/${id(8)}/runs/${id(10)}/messages/${id(9)}/sha256/${digest}`;
}

export function message(body: string) {
  const bytes = new TextEncoder().encode(body);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    digest,
    record: Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: id(7),
          bodyRef: {
            bucket: "platform-message-bodies",
            byteSize: bytes.byteLength,
            contentType: "text/plain; charset=utf-8",
            etag: "body-etag",
            key: messageBodyKey(digest),
            sha256: digest,
            versionId: "body-version",
          },
          contentHash: digest,
          createdAt: "2026-07-22T00:00:00.000Z",
          environmentId: id(3),
          id: id(9),
          organizationId: id(1),
          projectId: id(2),
          role: "user" as const,
          runId: id(10),
          sequence: 0,
          threadId: id(8),
        },
        itemType: "message" as const,
      }),
    ),
  };
}

export function bodyWrite(body: string, attempt = 1): AgentRunMessageBodyWrite {
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id(7),
        agentReleaseId: id(6),
        attempt,
        captureMode: "metadata-only" as const,
        createdAt: "2026-07-22T00:00:00.000Z",
        environmentId: id(3),
        executor: "hosted",
        id: id(10),
        idempotencyKey: "run/request-1",
        organizationId: id(1),
        priority: 1,
        projectId: id(2),
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "running" as const,
        threadId: id(8),
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "api",
        updatedAt: "2026-07-22T00:00:00.000Z",
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
  return {
    body,
    contentHash: createHash("sha256").update(body).digest("hex"),
    messageId: id(9),
    run,
  };
}
