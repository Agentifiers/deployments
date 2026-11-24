import { describe, expect, test } from "bun:test";
import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ArtifactRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { purgeRetainedArtifact } from "./artifact-retention-main.ts";

const RETENTION = "2026-08-25T12:00:00.000Z";

function artifact(versionId?: string, expiration: "retention" | "upload" = "retention") {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-25T12:00:00.000Z",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        name: "Report",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        ...(expiration === "retention"
          ? { retentionExpiresAt: RETENTION }
          : { uploadExpiresAt: RETENTION }),
        status: "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 12,
          contentType: "text/plain",
          fileName: "report.txt",
          key: "artifacts/report",
          sha256: "a".repeat(64),
          ...(versionId ? { versionId } : {}),
        },
        type: "report",
        updatedAt: "2026-07-25T12:00:00.000Z",
        version: 1,
        visibility: "private",
      },
      itemType: "artifact",
      ttl: Math.floor(Date.parse(RETENTION) / 1_000),
    }),
  );
}

function removal(record: ReturnType<typeof artifact>) {
  return {
    dynamodb: {
      OldImage: marshall(record, { removeUndefinedValues: true }),
      SequenceNumber: "101",
    },
    eventName: "REMOVE",
  } as const;
}

describe("artifact retention reaper", () => {
  test("deletes every version under a retained artifact key", async () => {
    const commands: unknown[] = [];
    await purgeRetainedArtifact(removal(artifact("version-1")), {
      send: async (command) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          return {
            DeleteMarkers: [{ Key: "artifacts/report", VersionId: "marker-1" }],
            Versions: [
              { Key: "artifacts/report", VersionId: "version-1" },
              { Key: "artifacts/report", VersionId: "version-after-completion" },
              { Key: "artifacts/report-sibling", VersionId: "sibling-version" },
            ],
          };
        }
        return {};
      },
    });

    expect(commands[0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(commands[1]).toBeInstanceOf(DeleteObjectsCommand);
    expect((commands[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "artifacts/report", VersionId: "version-1" },
      { Key: "artifacts/report", VersionId: "version-after-completion" },
      { Key: "artifacts/report", VersionId: "marker-1" },
    ]);
  });

  test("purges every version when a pending upload expired before completion", async () => {
    const commands: unknown[] = [];
    await purgeRetainedArtifact(removal(artifact(undefined, "upload")), {
      send: async (command) => {
        commands.push(command);
        if (command instanceof ListObjectVersionsCommand) {
          return {
            DeleteMarkers: [{ Key: "artifacts/report", VersionId: "marker-1" }],
            Versions: [{ Key: "artifacts/report", VersionId: "version-1" }],
          };
        }
        return {};
      },
    });

    expect(commands[0]).toBeInstanceOf(ListObjectVersionsCommand);
    expect(commands[1]).toBeInstanceOf(DeleteObjectsCommand);
    expect((commands[1] as DeleteObjectsCommand).input.Delete?.Objects).toEqual([
      { Key: "artifacts/report", VersionId: "version-1" },
      { Key: "artifacts/report", VersionId: "marker-1" },
    ]);
  });

  test("deletes every version of a run input file and of its extracted text", async () => {
    const scope = {
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    };
    const prefix = `artifacts/organizations/${scope.organizationId}/projects/${scope.projectId}/environments/${scope.environmentId}/customer/01ARZ3NDEKTSV4RRFFQ69G5FB4/${"a".repeat(64)}`;
    const versions: Readonly<Record<string, readonly string[]>> = {
      [`${prefix}/q3.pdf`]: ["source-1"],
      [`${prefix}/text/document-text-v1.txt`]: ["text-1", "text-crashed"],
    };
    const pending = Schema.decodeUnknownSync(ArtifactRecord)(
      withCanonicalRecordKeys({
        data: {
          ...artifact().data,
          name: "q3.pdf",
          status: "pending",
          storage: { ...artifact().data.storage, key: `${prefix}/q3.pdf` },
          type: "input",
          uploadExpiresAt: RETENTION,
        },
        itemType: "artifact",
        ttl: Math.floor(Date.parse(RETENTION) / 1_000),
      }),
    );
    const deleted: unknown[] = [];

    await purgeRetainedArtifact(removal(pending), {
      send: async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: Object.entries(versions).flatMap(([key, ids]) =>
              key.startsWith(command.input.Prefix ?? "")
                ? ids.map((VersionId) => ({ Key: key, VersionId }))
                : [],
            ),
          };
        }
        deleted.push(...(command.input.Delete?.Objects ?? []));
        return {};
      },
    });

    expect(deleted).toEqual([
      { Key: `${prefix}/q3.pdf`, VersionId: "source-1" },
      { Key: `${prefix}/text/document-text-v1.txt`, VersionId: "text-1" },
      { Key: `${prefix}/text/document-text-v1.txt`, VersionId: "text-crashed" },
    ]);
  });

  test("purges an input upload that completed before resolution existed", async () => {
    const prefix = `artifacts/organizations/01ARZ3NDEKTSV4RRFFQ69G5FAV/projects/01ARZ3NDEKTSV4RRFFQ69G5FAW/environments/01ARZ3NDEKTSV4RRFFQ69G5FAX/customer/01ARZ3NDEKTSV4RRFFQ69G5FB4/${"a".repeat(64)}`;
    const uploaded = artifact("source-1");
    const unresolved = {
      ...uploaded,
      data: {
        ...uploaded.data,
        name: "photo.png",
        storage: { ...uploaded.data.storage, contentType: "image/png", key: `${prefix}/photo.png` },
        type: "input",
      },
    };
    const deleted: unknown[] = [];

    await purgeRetainedArtifact(removal(unresolved), {
      send: async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          return command.input.Prefix === `${prefix}/photo.png`
            ? { Versions: [{ Key: `${prefix}/photo.png`, VersionId: "source-1" }] }
            : {};
        }
        deleted.push(...(command.input.Delete?.Objects ?? []));
        return {};
      },
    });

    expect(deleted).toEqual([{ Key: `${prefix}/photo.png`, VersionId: "source-1" }]);
  });

  test("deletes the extracted text of an input document removed without a retention date", async () => {
    const prefix = `artifacts/organizations/01ARZ3NDEKTSV4RRFFQ69G5FAV/projects/01ARZ3NDEKTSV4RRFFQ69G5FAW/environments/01ARZ3NDEKTSV4RRFFQ69G5FAX/customer/01ARZ3NDEKTSV4RRFFQ69G5FB4/${"a".repeat(64)}`;
    const { retentionExpiresAt: _retention, ...unretained } = artifact("source-1").data;
    const document = Schema.decodeUnknownSync(ArtifactRecord)(
      withCanonicalRecordKeys({
        data: {
          ...unretained,
          input: {
            kind: "document",
            mediaType: "application/pdf",
            summary: "PDF, 1 page",
            text: {
              byteSize: 23,
              extractor: "document-text-v1",
              sha256: "b".repeat(64),
              truncated: false,
              versionId: "text-1",
            },
          },
          name: "q3.pdf",
          storage: { ...unretained.storage, key: `${prefix}/q3.pdf` },
          type: "input",
        },
        itemType: "artifact",
      }),
    );
    const deleted: unknown[] = [];

    await purgeRetainedArtifact(removal(document), {
      send: async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          const key = command.input.Prefix ?? "";
          return { Versions: [{ Key: key, VersionId: `${key.split("/").at(-1)}-1` }] };
        }
        deleted.push(...(command.input.Delete?.Objects ?? []));
        return {};
      },
    });

    expect(deleted).toEqual([
      { Key: `${prefix}/text/document-text-v1.txt`, VersionId: "document-text-v1.txt-1" },
    ]);
  });
});
