import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { ArtifactRecord } from "../records/artifacts.ts";
import { MessageRecord } from "../records/conversations.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  listReadableAttachments,
  loadReadableAttachment,
  loadRunInputArtifacts,
} from "./input-artifacts.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`;
const ulid = (suffix: string) => Schema.decodeUnknownSync(Ulid)(id(suffix));
const now = new Date("2026-09-10T12:00:00.000Z");
const MIB = 1024 * 1024;
const scope = {
  organizationId: id("1"),
  projectId: id("2"),
  environmentId: id("3"),
  threadId: id("4"),
  owner: { serviceAccountId: ulid("5"), type: "service-account" as const },
};
const csv = {
  kind: "document",
  mediaType: "text/csv",
  summary: "CSV file, 3 rows",
  text: {
    byteSize: 40,
    extractor: "document-text-v1",
    sha256: "b".repeat(64),
    truncated: false,
    versionId: "text-v1",
  },
} as const;

function record(overrides: Record<string, unknown> = {}) {
  const retentionExpiresAt =
    typeof overrides.retentionExpiresAt === "string"
      ? overrides.retentionExpiresAt
      : new Date(now.getTime() + 1000).toISOString();
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      itemType: "artifact",
      ttl: Math.floor(Date.parse(retentionExpiresAt) / 1000),
      data: Object.fromEntries(
        Object.entries({
          ...scope,
          id: id("6"),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          version: 0,
          name: "frame.jpg",
          type: "input",
          input: { kind: "image", mediaType: "image/jpeg" },
          status: "available",
          visibility: "private",
          retentionExpiresAt,
          storage: {
            bucket: "private-artifacts",
            key: "committed-object",
            byteSize: 1024,
            contentType: "image/jpeg",
            sha256: "a".repeat(64),
            versionId: "v1",
          },
          ...overrides,
        }).filter(([, value]) => value !== undefined),
      ),
    }),
  );
}

function userMessage(sequence: number, inputArtifacts: readonly string[], createdAt: Date) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      itemType: "message",
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        id: id(String(80 + sequence)),
        body: "Look at this.",
        contentHash: "hash",
        createdAt: createdAt.toISOString(),
        inputArtifacts,
        role: "user",
        sequence,
      },
    }),
  );
}

function database(...records: readonly PlatformRecord[]): DynamoDatabaseService {
  return {
    getRecord: (_table, recordKey) =>
      Promise.resolve(records.find((record) => record.sk === recordKey.sk)),
    queryRecords: (_table, input) => {
      const newestFirst = records
        .filter((record) => record.sk.startsWith("MESSAGE#"))
        .toSorted((left, right) => right.sk.localeCompare(left.sk));
      const start = newestFirst.findIndex((record) => record.sk === input.ExclusiveStartKey?.sk);
      const items = newestFirst.slice(start + 1, start + 1 + (input.Limit ?? newestFirst.length));
      const last = items.at(-1);
      return Promise.resolve({
        items,
        ...(last && last !== newestFirst.at(-1)
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      });
    },
    putRecord: () => Promise.resolve(),
    deleteRecord: () => Promise.resolve(),
    transactWrite: () => Promise.resolve(),
  };
}

describe("private run input artifact repository", () => {
  test("authorizes the exact service account and conversation, not possession of an ID", async () => {
    const artifact = record();
    const input = { ...scope, artifactIds: [id("6")], now };
    expect(
      (await loadRunInputArtifacts(database(artifact), input)).map(({ file, record }) => ({
        file,
        id: String(record.data.id),
      })),
    ).toEqual([{ file: { kind: "image", mediaType: "image/jpeg" }, id: id("6") }]);
    for (const changedScope of [
      { owner: { serviceAccountId: ulid("7"), type: "service-account" as const } },
      { threadId: id("7") },
      { organizationId: id("7") },
      { environmentId: id("7") },
      { projectId: id("7") },
    ])
      expect(
        loadRunInputArtifacts(database(artifact), { ...input, ...changedScope }),
      ).rejects.toMatchObject({ code: "input_artifact_unavailable" });
  });

  test("matches owners by kind: a principal owner never matches a service-account owner with the same ULID", async () => {
    const artifact = record({ owner: { principalId: ulid("5"), type: "principal" } });
    const input = { ...scope, artifactIds: [id("6")], now };
    const loaded = await loadRunInputArtifacts(database(artifact), {
      ...input,
      owner: { principalId: ulid("5"), type: "principal" },
    });
    expect(loaded.map(({ record }) => String(record.data.id))).toEqual([id("6")]);
    for (const owner of [
      { serviceAccountId: ulid("5"), type: "service-account" as const },
      { sourceId: ulid("5"), sourceKind: "channel-binding" as const, type: "ingress" as const },
    ])
      expect(
        await loadRunInputArtifacts(database(artifact), { ...input, owner }).catch(
          (cause: unknown) => cause,
        ),
      ).toMatchObject({ code: "input_artifact_unavailable" });
  });

  test("checks logical expiry, deletion and private runtime-only access without trusting TTL cleanup", async () => {
    const input = { ...scope, artifactIds: [id("6")], now };
    for (const changedRecord of [
      { retentionExpiresAt: now.toISOString() },
      { input: undefined, status: "pending" },
      { status: "deleted" },
      { visibility: "organization" },
      { privateAccess: "runtime-only" },
    ])
      expect(loadRunInputArtifacts(database(record(changedRecord)), input)).rejects.toMatchObject({
        code: "input_artifact_unavailable",
      });
  });

  test("refuses an upload that is not run input and names a file that can't be used", async () => {
    const input = { ...scope, artifactIds: [id("6")], now };
    expect(
      loadRunInputArtifacts(database(record({ input: undefined, type: "image" })), input),
    ).rejects.toMatchObject({ code: "invalid_input_artifacts" });
    expect(
      loadRunInputArtifacts(
        database(record({ input: { kind: "unusable", reason: "no_text" }, name: "scan.pdf" })),
        input,
      ),
    ).rejects.toMatchObject({
      code: "input_file_no_text",
      message: `Input file ${id("6")} (scan.pdf) can't be used: the file has no readable text. If it is a scan, OCR found no text or isn't turned on.`,
    });
  });

  test("treats an input upload that completed before resolution existed as unavailable to every reader", async () => {
    const naming = userMessage(1, [id("6")], new Date(now.getTime() + 60_000));
    const readers = async (artifact: PlatformRecord) => ({
      listed: (
        await listReadableAttachments(database(artifact, naming), {
          ...scope,
          candidates: [{ artifactId: id("6") }],
          now,
        })
      ).map(({ record }) => record.data.name),
      loaded: await loadRunInputArtifacts(database(artifact), {
        ...scope,
        artifactIds: [id("6")],
        now,
      })
        .then((loaded) => loaded.map(({ record }) => record.data.name))
        .catch((cause: { readonly code: string }) => cause.code),
      read: await loadReadableAttachment(database(artifact, naming), {
        ...scope,
        artifactId: id("6"),
        now,
        submitted: [id("6")],
      })
        .then(({ record }) => record.data.name)
        .catch((cause: { readonly code: string }) => cause.code),
    });

    expect([
      await readers(record({ input: csv, name: "q3.csv" })),
      await readers(record({ input: undefined, name: "q3.csv" })),
    ]).toEqual([
      { listed: ["q3.csv"], loaded: ["q3.csv"], read: "q3.csv" },
      { listed: [], loaded: "input_artifact_unavailable", read: "input_artifact_unavailable" },
    ]);
  });

  test("counts only image and audio bytes against the aggregate limit", async () => {
    const image = (suffix: string) =>
      record({ id: id(suffix), storage: { ...record().data.storage, byteSize: 8 * MIB } });
    const document = record({
      id: id("12"),
      input: csv,
      storage: { ...record().data.storage, byteSize: 9 * MIB, contentType: "text/csv" },
    });
    const twoImagesAndADocument = { ...scope, artifactIds: [id("10"), id("11"), id("12")], now };
    expect(
      (
        await loadRunInputArtifacts(
          database(image("10"), image("11"), document),
          twoImagesAndADocument,
        )
      ).map(({ file }) => file.kind),
    ).toEqual(["image", "image", "document"]);
    expect(
      loadRunInputArtifacts(database(image("10"), image("11"), image("13")), {
        ...twoImagesAndADocument,
        artifactIds: [id("10"), id("11"), id("13")],
      }),
    ).rejects.toMatchObject({ code: "invalid_input_artifacts" });
  });
});

describe("readable attachments", () => {
  const document = record({ input: csv, name: "q3.csv" });
  const read = (records: readonly PlatformRecord[], submitted: readonly string[] = []) =>
    loadReadableAttachment(database(...records), { ...scope, artifactId: id("6"), now, submitted })
      .then(({ record }) => record.data.name)
      .catch((cause: { readonly code: string }) => cause.code);

  test("reads a document the run submitted or an earlier user message in the thread named", async () => {
    const later = new Date(now.getTime() + 60_000);
    expect(await read([document], [id("6")])).toBe("q3.csv");
    expect(
      await read([
        document,
        userMessage(1, [id("6")], later),
        userMessage(2, [id("9")], later),
        userMessage(3, [id("9")], later),
      ]),
    ).toBe("q3.csv");
  });

  test("refuses a document no user message named, an image, and another owner's document", async () => {
    const later = new Date(now.getTime() + 60_000);
    const before = new Date(now.getTime() - 60_000);
    expect(
      await read([document, userMessage(1, [id("6")], before), userMessage(2, [id("9")], later)]),
    ).toBe("input_artifact_unavailable");
    expect(await read([record()], [id("6")])).toBe("input_artifact_unavailable");
    expect(
      await read(
        [record({ input: csv, owner: { principalId: ulid("5"), type: "principal" } })],
        [id("6")],
      ),
    ).toBe("input_artifact_unavailable");
  });
});

describe("earlier attachment index", () => {
  const later = new Date(now.getTime() + 60_000);
  const list = (records: readonly PlatformRecord[], candidates: readonly string[]) =>
    listReadableAttachments(database(...records), {
      ...scope,
      candidates: candidates.map((artifactId, turnsAgo) => ({ artifactId, turnsAgo })),
      now,
    }).then((listed) =>
      listed.map(({ candidate, record }) => [record.data.name, candidate.turnsAgo]),
    );
  const read = (records: readonly PlatformRecord[]) =>
    loadReadableAttachment(database(...records), {
      ...scope,
      artifactId: id("6"),
      now,
      submitted: [],
    })
      .then(({ record }) => record.data.name)
      .catch((cause: { readonly code: string }) => cause.code);

  test("lists the first twelve documents a user message named that this owner may read", async () => {
    const documents = Array.from({ length: 14 }, (_, index) =>
      record({ id: id(String(20 + index)), input: csv, name: `q${index}.csv` }),
    );
    const unreadable = [
      record({ id: id("40") }),
      record({ id: id("41"), input: csv, retentionExpiresAt: now.toISOString() }),
      record({ id: id("42"), input: csv, owner: { principalId: ulid("5"), type: "principal" } }),
      record({ id: id("44"), input: csv, name: "never-named.csv" }),
    ];
    const named = [id("40"), id("41"), id("42"), id("43"), ...documents.map(({ data }) => data.id)];

    expect(
      await list(
        [
          ...unreadable,
          ...documents,
          userMessage(1, named.slice(0, 8), later),
          userMessage(2, named.slice(8, 16), later),
          userMessage(3, named.slice(16), later),
        ],
        [...named.slice(0, 4), id("44"), ...named.slice(4)],
      ),
    ).toEqual([
      ["q0.csv", 5],
      ["q1.csv", 6],
      ["q2.csv", 7],
      ["q3.csv", 8],
      ["q4.csv", 9],
      ["q5.csv", 10],
      ["q6.csv", 11],
      ["q7.csv", 12],
      ["q8.csv", 13],
      ["q9.csv", 14],
      ["q10.csv", 15],
      ["q11.csv", 16],
    ]);
  });

  test("checks only the first 48 candidates", async () => {
    const document = record({ input: csv, name: "q3.csv" });
    const naming = userMessage(1, [id("6")], later);
    const images = Array.from({ length: 48 }, (_, index) => id(String(100 + index)));

    expect(await list([document, naming], [...images.slice(0, 47), id("6")])).toEqual([
      ["q3.csv", 47],
    ]);
    expect(await list([document, naming], [...images, id("6")])).toEqual([]);
  });

  test("lists a document only while attachment.read's scan of the newest 400 messages finds it", async () => {
    const document = record({ input: csv, name: "q3.csv" });
    const naming = userMessage(1, [id("6")], later);
    const newer = (count: number) =>
      Array.from({ length: count }, (_, index) => userMessage(2 + index, [id("9999")], later));

    const withinScan = [document, naming, ...newer(399)];
    expect([await list(withinScan, [id("6")]), await read(withinScan)]).toEqual([
      [["q3.csv", 0]],
      "q3.csv",
    ]);
    const pastScan = [document, naming, ...newer(400)];
    expect([await list(pastScan, [id("6")]), await read(pastScan)]).toEqual([
      [],
      "input_artifact_unavailable",
    ]);
  });

  test("gives an email binding's turn only its own message's files, unlike a channel binding's", async () => {
    const outcomes: unknown[] = [];
    for (const sourceKind of ["agent-email-binding", "channel-binding"] as const) {
      const owner = { sourceId: ulid("7"), sourceKind, type: "ingress" as const };
      const thread = database(
        record({ input: { ...csv, mediaType: "application/pdf" }, name: "statement.pdf", owner }),
        userMessage(1, [id("6")], later),
      );
      const readOnTurn = (submitted: readonly string[]) =>
        loadReadableAttachment(thread, { ...scope, artifactId: id("6"), now, owner, submitted })
          .then(({ record }) => record.data.name)
          .catch((cause: { readonly code: string }) => cause.code);
      outcomes.push({
        listed: (
          await listReadableAttachments(thread, {
            ...scope,
            candidates: [{ artifactId: id("6") }],
            now,
            owner,
          })
        ).map(({ record }) => record.data.name),
        readOnLaterTurn: await readOnTurn([]),
        readOnOwnTurn: await readOnTurn([id("6")]),
      });
    }

    expect(outcomes).toEqual([
      { listed: [], readOnLaterTurn: "input_artifact_unavailable", readOnOwnTurn: "statement.pdf" },
      {
        listed: ["statement.pdf"],
        readOnLaterTurn: "statement.pdf",
        readOnOwnTurn: "statement.pdf",
      },
    ]);
  });
});
