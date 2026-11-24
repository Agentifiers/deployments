import { ExtractionUnavailableError } from "@deployments-ai/file-text";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS,
  INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS,
  IngressAttachmentReadError,
  makeIngressAttachments,
  type IngressAttachmentCandidate,
  type IngressAttachmentsDependencies,
} from "./index.ts";
import {
  KMS_KEY_ARN,
  NOW,
  channelAttachment,
  customerKey,
  fakeExtractor,
  fakeProvider,
  memoryArtifactBucket,
  memoryDatabase,
  otherThreadId,
  owner,
  pdfAttachment,
  pdfBytes,
  pngBytes,
  scope,
  sha256Hex,
  threadId,
  ulid,
} from "./ingress-attachments.fixture.ts";

const PHOTO_ID = ulid("3D0R7ZD0ZM9Y5Y72WDKZQY0MGE");
const PHOTO_ID_IN_OTHER_THREAD = ulid("63WGJ65NZFH8GKTJJ0JKZ6SVSQ");
const SPOOFED_ID = ulid("1MVSB7WKW46SCZA11EZD44DV9J");
const REPORT_ID = ulid("3Q5A9QQHCTT16CV9GJP3ZXVQHM");
const MIB = 1024 * 1024;

function setup(
  files: Parameters<typeof fakeProvider>[0],
  options: {
    readonly onTransientFailure?: IngressAttachmentsDependencies<string>["onTransientFailure"];
    readonly respond?: Parameters<typeof fakeExtractor>[0];
  } = {},
) {
  const db = memoryDatabase();
  const bucket = memoryArtifactBucket();
  const provider = fakeProvider(files);
  const extraction = fakeExtractor(options.respond);
  const attachments = makeIngressAttachments({
    artifactBucket: "artifacts",
    database: db.database,
    extractor: extraction.extractor,
    now: () => NOW,
    onTransientFailure: options.onTransientFailure ?? "omit",
    openObjectStore: bucket.openObjectStore,
    openReader: provider.openReader,
  });
  return { attachments, bucket, db, extraction, provider };
}

const photo = [channelAttachment("1712345678.000100", 0, "photo-1")];
const report = [pdfAttachment("m1", 0, "report.pdf")];
const REPORT = pdfBytes("three pages about revenue");
const capture = { capture: true, owner, scope, threadId } as const;

describe("ingress attachments", () => {
  test("a PDF becomes an available input artifact named after the file, stored as @input, with its text", async () => {
    const { attachments, bucket, db, extraction } = setup({ "report.pdf": REPORT });

    expect(await attachments.prepare({ ...capture, candidates: report })).toEqual({
      offeredArtifactIds: [REPORT_ID],
      omitted: [],
      skipped: [],
    });
    const sourceKey = customerKey(REPORT_ID, sha256Hex(REPORT), "@input");
    const textKey = customerKey(REPORT_ID, sha256Hex(REPORT), "text/document-text-v1.txt");
    const text = new TextEncoder().encode("--- Page 1 ---\nRevenue grew.");
    expect((await db.artifact(REPORT_ID))?.data).toMatchObject({
      input: {
        kind: "document",
        mediaType: "application/pdf",
        summary: "PDF, 2 pages",
        text: {
          byteSize: 28,
          extractor: "document-text-v1",
          sha256: sha256Hex(text),
          truncated: false,
          versionId: "version-2",
        },
      },
      name: "report.pdf",
      status: "available",
      storage: {
        contentType: "application/octet-stream",
        fileName: "@input",
        key: sourceKey,
        sha256: sha256Hex(REPORT),
        versionId: "version-1",
      },
      type: "input",
      visibility: "private",
    });
    expect(bucket.objects.get(textKey)?.bytes).toEqual(text);

    const [request] = extraction.requests;
    const url = new URL(request?.source.url ?? "");
    expect({
      deadlineMs: request?.deadlineMs,
      hint: request?.hint,
      host: url.host,
      path: url.pathname,
      size: request?.source.byteSize,
      sha256: request?.source.sha256,
      versionId: url.searchParams.get("versionId"),
    }).toEqual({
      deadlineMs: 20_000,
      hint: { contentType: "application/pdf", fileName: "report.pdf" },
      host: "artifacts.s3.us-east-1.amazonaws.com",
      path: `/${customerKey(REPORT_ID, sha256Hex(REPORT), "%40input")}`,
      sha256: sha256Hex(REPORT),
      size: REPORT.byteLength,
      versionId: "version-1",
    });
  });

  test("a corrupt PDF is stored with an unusable resolution, not left out", async () => {
    const { attachments, bucket, db } = setup(
      { "report.pdf": REPORT },
      {
        respond: async () => ({
          detail: "broken xref table",
          reason: "unreadable",
          status: "unusable",
        }),
      },
    );

    expect((await attachments.prepare({ ...capture, candidates: report })).omitted).toEqual([]);
    expect((await db.artifact(REPORT_ID))?.data).toMatchObject({
      input: { detail: "broken xref table", kind: "unusable", reason: "unreadable" },
      status: "available",
    });
    expect([...bucket.objects.keys()]).toEqual([
      customerKey(REPORT_ID, sha256Hex(REPORT), "@input"),
    ]);
  });

  test("five PDFs give four offered and one skipped over the turn cap", async () => {
    const names = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"];
    const { attachments, provider } = setup(
      Object.fromEntries(names.map((name) => [name, pdfBytes(name)])),
    );
    const result = await attachments.prepare({
      ...capture,
      candidates: names.map((name, ordinal) => pdfAttachment("m1", ordinal, name)),
    });

    expect(result.offeredArtifactIds).toHaveLength(4);
    expect(result.skipped).toEqual([
      {
        identity: { externalMessageId: "m1", ordinal: 4, type: "channel-attachment" },
        name: "e.pdf",
        reason: "over_turn_cap",
      },
    ]);
    expect(provider.reads).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
  });

  test("a file declared over 10 MiB is skipped as too large and never downloaded", async () => {
    const { attachments, db, provider } = setup({});
    const big = channelAttachment("m1", 0, "big", {
      byteSize: 12 * MIB,
      contentType: "application/pdf",
      fileName: "board-pack.pdf",
    });

    expect(await attachments.prepare({ ...capture, candidates: [big] })).toEqual({
      offeredArtifactIds: [],
      omitted: [],
      skipped: [
        {
          identity: { externalMessageId: "m1", ordinal: 0, type: "channel-attachment" },
          name: "board-pack.pdf",
          reason: "too_large",
        },
      ],
    });
    expect([provider.reads.length, db.records.size]).toEqual([0, 0]);
  });

  test("unsupported and legacy files are skipped by name", async () => {
    const { attachments } = setup({});
    const declared: IngressAttachmentCandidate<string>["declared"][] = [
      { contentType: "application/vnd.ms-excel", fileName: "q3.xls", kind: "file" },
      { fileName: "deck.pptx", kind: "file" },
      { contentType: "audio/mpeg", fileName: "voice.mp3", kind: "audio" },
      { contentType: "image/heic", fileName: "IMG_0001.HEIC", kind: "image" },
      { contentType: "application/octet-stream", kind: "file" },
    ];
    const result = await attachments.prepare({
      ...capture,
      candidates: declared.map((file, ordinal) => channelAttachment("m1", ordinal, "x", file)),
    });

    expect(result.offeredArtifactIds).toEqual([]);
    expect(result.skipped.map(({ name, reason }) => [name, reason])).toEqual([
      ["q3.xls", "legacy_office_format"],
      ["deck.pptx", "unsupported_type"],
      ["voice.mp3", "unsupported_type"],
      ["IMG_0001.HEIC", "unsupported_type"],
      ["attachment-5", "unsupported_type"],
    ]);
  });

  test("a turn takes four images and four documents in message order", async () => {
    const images = ["a", "b", "c", "d", "e"].map((name) => `${name}.png`);
    const documents = ["notes.txt", "q3.xlsx", "data.csv", "spec.docx", "extra.md"];
    const { attachments, provider } = setup(
      Object.fromEntries([
        ...images.map((name) => [name, pngBytes(name)]),
        ...documents.map((name) => [name, new TextEncoder().encode(name)]),
      ]),
    );
    const result = await attachments.prepare({
      ...capture,
      candidates: [...images, ...documents].map((name, ordinal) =>
        channelAttachment("m1", ordinal, name, { fileName: name, kind: "file" }),
      ),
    });

    expect(result.offeredArtifactIds).toHaveLength(8);
    expect(result.skipped.map(({ name, reason }) => [name, reason])).toEqual([
      ["e.png", "over_turn_cap"],
      ["extra.md", "over_turn_cap"],
    ]);
    expect(provider.reads).toEqual([
      "a.png",
      "b.png",
      "c.png",
      "d.png",
      "notes.txt",
      "q3.xlsx",
      "data.csv",
      "spec.docx",
    ]);
  });

  test("the same journal gives the same ids on every call", async () => {
    const { attachments } = setup({ "photo-1": pngBytes("one"), "report.pdf": REPORT });
    const request = { ...capture, candidates: [...photo, ...report] };

    expect((await attachments.prepare(request)).offeredArtifactIds).toEqual([PHOTO_ID, REPORT_ID]);
    expect((await attachments.prepare(request)).offeredArtifactIds).toEqual([PHOTO_ID, REPORT_ID]);
  });

  test("an image is typed in-process and never invokes the extractor", async () => {
    const source = pngBytes("a photo from the provider");
    const { attachments, bucket, db, extraction } = setup({ "photo-1": source });
    await attachments.prepare({ ...capture, candidates: photo });

    expect(extraction.requests).toEqual([]);
    const [stored] = [...bucket.objects.values()];
    expect(stored && sha256Hex(stored.bytes)).toBe(sha256Hex(source));
    expect([stored?.contentType, stored?.kmsKeyId]).toEqual([
      "application/octet-stream",
      KMS_KEY_ARN,
    ]);
    expect((await db.artifact(PHOTO_ID))?.data).toMatchObject({
      input: { kind: "image", mediaType: "image/png" },
      name: "photo.png",
      owner: { sourceId: owner.sourceId, sourceKind: "channel-binding", type: "ingress" },
      retentionExpiresAt: "2026-11-06T12:00:00.000Z",
      status: "available",
      storage: {
        bucket: "artifacts",
        byteSize: source.byteLength,
        contentType: "application/octet-stream",
        fileName: "@input",
        key: customerKey(PHOTO_ID, sha256Hex(source), "@input"),
        sha256: sha256Hex(source),
        versionId: "version-1",
      },
      threadId,
      type: "input",
      visibility: "private",
    });
  });

  test("bytes that are not the image they claim to be go to the extractor", async () => {
    const { attachments, db, extraction } = setup(
      {
        "photo-1": pngBytes("one"),
        "spoofed.png": new TextEncoder().encode("<!doctype html><title>login</title>"),
      },
      { respond: async () => ({ reason: "unsupported_type", status: "unusable" }) },
    );
    const spoofed = channelAttachment("1712345678.000100", 1, "spoofed.png", {
      contentType: "image/png",
      fileName: "spoofed.png",
      kind: "image",
    });
    const result = await attachments.prepare({ ...capture, candidates: [...photo, spoofed] });

    expect(result).toEqual({
      offeredArtifactIds: [PHOTO_ID, SPOOFED_ID],
      omitted: [],
      skipped: [],
    });
    expect(extraction.requests.map(({ hint }) => hint)).toEqual([
      { contentType: "image/png", fileName: "spoofed.png" },
    ]);
    expect((await db.artifact(SPOOFED_ID))?.data.input).toEqual({
      kind: "unusable",
      reason: "unsupported_type",
    });
  });

  test("an extraction outage leaves the document pending; email mode rethrows it", async () => {
    const outage = async () => {
      throw new ExtractionUnavailableError("Document extraction could not be invoked.");
    };
    const omitting = setup({ "report.pdf": REPORT }, { respond: outage });

    expect(
      (await omitting.attachments.prepare({ ...capture, candidates: report })).omitted,
    ).toEqual([{ artifactId: REPORT_ID, reason: "extraction_unavailable" }]);
    expect((await omitting.db.artifact(REPORT_ID))?.data.status).toBe("pending");
    expect(
      setup(
        { "report.pdf": REPORT },
        { onTransientFailure: "throw", respond: outage },
      ).attachments.prepare({ ...capture, candidates: report }),
    ).rejects.toThrow("Document extraction could not be invoked.");
  });

  test("a captured id is reused with no second fetch or put", async () => {
    const { attachments, bucket, db, provider } = setup({ "photo-1": pngBytes("one") });
    const request = { ...capture, candidates: photo };

    await attachments.prepare(request);
    expect(await attachments.prepare(request)).toEqual({
      offeredArtifactIds: [PHOTO_ID],
      omitted: [],
      skipped: [],
    });
    expect(provider.reads).toEqual(["photo-1"]);
    expect([...bucket.objects.values()].map((object) => object.versionId)).toEqual(["version-1"]);
    expect((await db.artifact(PHOTO_ID))?.data.status).toBe("available");
  });

  test("capture: false fetches nothing but returns the same ids", async () => {
    const { attachments, db, provider } = setup({ "photo-1": pngBytes("one") });
    const request = { candidates: photo, owner, scope, threadId };

    expect(await attachments.prepare({ ...request, capture: false })).toEqual({
      offeredArtifactIds: [PHOTO_ID],
      omitted: [],
      skipped: [],
    });
    expect([provider.reads.length, db.records.size]).toEqual([0, 0]);
    expect((await attachments.prepare({ ...request, capture: true })).offeredArtifactIds).toEqual([
      PHOTO_ID,
    ]);
    expect(provider.reads).toEqual(["photo-1"]);
  });

  test("the object store opens once per call, with the call's scope, only when bytes must be stored", async () => {
    const { attachments, bucket } = setup({
      a: pngBytes("a"),
      b: pngBytes("b"),
      gone: new IngressAttachmentReadError("permanent", "Provider returned 404."),
    });
    const otherScope = { ...scope, environmentId: ulid("01ARZ3NDEKTSV4RRFFQ69G5009") };
    const pair = [channelAttachment("m1", 0, "a"), channelAttachment("m1", 1, "b")];

    await attachments.prepare({ ...capture, candidates: pair });
    await attachments.prepare({ ...capture, candidates: pair });
    await attachments.prepare({
      ...capture,
      candidates: [channelAttachment("m2", 0, "gone")],
      scope: otherScope,
    });
    await attachments.prepare({
      ...capture,
      candidates: [channelAttachment("m3", 0, "a")],
      capture: false,
      scope: otherScope,
    });
    expect(bucket.opened).toEqual([scope]);

    await attachments.prepare({
      ...capture,
      candidates: [channelAttachment("m4", 0, "b")],
      scope: otherScope,
    });
    expect(bucket.opened).toEqual([scope, otherScope]);
    expect(bucket.objects.size).toBe(3);
  });

  test("a 412 recovers the existing object", async () => {
    const { attachments, bucket, db } = setup({ "photo-1": pngBytes("one") });
    const request = { ...capture, candidates: photo };
    db.failures.nextTransaction = true;

    expect((await attachments.prepare(request)).omitted).toEqual([
      { artifactId: PHOTO_ID, reason: "store_failed" },
    ]);
    expect((await db.artifact(PHOTO_ID))?.data.status).toBe("pending");
    expect(await attachments.prepare(request)).toEqual({
      offeredArtifactIds: [PHOTO_ID],
      omitted: [],
      skipped: [],
    });
    expect((await db.artifact(PHOTO_ID))?.data).toMatchObject({
      status: "available",
      storage: { etag: '"etag-version-1"', versionId: "version-1" },
    });
    expect([...bucket.objects.values()].map((object) => object.versionId)).toEqual(["version-1"]);
  });

  test("two concurrent captures of one image converge on one object and one available record", async () => {
    const { attachments, bucket, db, provider } = setup({ "photo-1": pngBytes("one") });
    const request = { ...capture, candidates: photo };

    expect(await Promise.all([attachments.prepare(request), attachments.prepare(request)])).toEqual(
      [
        { offeredArtifactIds: [PHOTO_ID], omitted: [], skipped: [] },
        { offeredArtifactIds: [PHOTO_ID], omitted: [], skipped: [] },
      ],
    );
    expect(provider.reads).toEqual(["photo-1", "photo-1"]);
    expect([...bucket.objects.values()].map((object) => object.versionId)).toEqual(["version-1"]);
    expect((await db.artifact(PHOTO_ID))?.data).toMatchObject({
      status: "available",
      storage: { versionId: "version-1" },
      version: 1,
    });
  });

  test("a crash after the pending record and before the put leaves a pending record that the next call completes", async () => {
    const { attachments, bucket, db, provider } = setup({ "photo-1": pngBytes("one") });
    const request = { ...capture, candidates: photo };
    bucket.failures.nextPut = true;

    expect((await attachments.prepare(request)).omitted).toEqual([
      { artifactId: PHOTO_ID, reason: "store_failed" },
    ]);
    const pending = await db.artifact(PHOTO_ID);
    expect([pending?.data.status, pending?.data.uploadExpiresAt, pending?.ttl]).toEqual([
      "pending",
      "2026-10-08T12:00:00.000Z",
      Date.parse("2026-10-08T12:00:00.000Z") / 1000,
    ]);
    expect(bucket.objects.size).toBe(0);

    expect((await attachments.prepare(request)).omitted).toEqual([]);
    const available = await db.artifact(PHOTO_ID);
    expect([
      available?.data.status,
      available?.data.retentionExpiresAt,
      available?.data.uploadExpiresAt,
      available?.ttl,
    ]).toEqual([
      "available",
      "2026-11-06T12:00:00.000Z",
      undefined,
      Date.parse("2026-11-06T12:00:00.000Z") / 1000,
    ]);
    expect(provider.reads).toEqual(["photo-1", "photo-1"]);
    expect(bucket.objects.size).toBe(1);
  });

  test("the same provider message id in two threads of one binding gives different ids", async () => {
    const { attachments } = setup({});
    const request = { candidates: photo, capture: false, owner, scope };

    expect((await attachments.prepare({ ...request, threadId })).offeredArtifactIds).toEqual([
      PHOTO_ID,
    ]);
    expect(
      (await attachments.prepare({ ...request, threadId: otherThreadId })).offeredArtifactIds,
    ).toEqual([PHOTO_ID_IN_OTHER_THREAD]);
  });

  test("email mode rethrows a transient read failure while channel mode omits it", async () => {
    const files = {
      "photo-1": new IngressAttachmentReadError("transient", "Provider returned 503."),
    };
    const request = { ...capture, candidates: photo };

    expect((await setup(files).attachments.prepare(request)).omitted).toEqual([
      { artifactId: PHOTO_ID, reason: "unavailable" },
    ]);
    expect(
      setup(files, { onTransientFailure: "throw" }).attachments.prepare(request),
    ).rejects.toThrow("Provider returned 503.");
  });

  test("a permanent read failure is omitted in either mode", async () => {
    const files = {
      "photo-1": new IngressAttachmentReadError("permanent", "Provider returned 404."),
    };
    const request = { ...capture, candidates: photo };

    expect(
      (await setup(files, { onTransientFailure: "throw" }).attachments.prepare(request)).omitted,
    ).toEqual([{ artifactId: PHOTO_ID, reason: "unreadable" }]);
  });

  test("a resolution the artifact record cannot hold is left out in either mode, never retried", async () => {
    const { attachments, db } = setup(
      { "report.pdf": REPORT },
      {
        onTransientFailure: "throw",
        respond: async () => ({
          detail: "x".repeat(201),
          reason: "unreadable",
          status: "unusable",
        }),
      },
    );

    expect((await attachments.prepare({ ...capture, candidates: report })).omitted).toEqual([
      { artifactId: REPORT_ID, reason: "artifact_unusable" },
    ]);
    expect((await db.artifact(REPORT_ID))?.data.status).toBe("pending");
  });

  describe("when earlier captures used up part of the budget", () => {
    const STARTED_AT = Date.parse("2026-10-07T12:00:00.000Z");
    const SHORTENED_DEADLINE_MS = INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS - 5_000;
    const READ_ENDS_AT = STARTED_AT + INGRESS_ATTACHMENT_CAPTURE_BUDGET_MS - SHORTENED_DEADLINE_MS;
    afterEach(() => {
      setSystemTime();
    });

    function lateCapture(extractionMs: number) {
      const db = memoryDatabase();
      const bucket = memoryArtifactBucket();
      const extraction = fakeExtractor(async () => {
        setSystemTime(new Date(Date.now() + extractionMs));
        return { detail: "out of time", reason: "limits_exceeded", status: "unusable" };
      });
      const attachments = makeIngressAttachments({
        artifactBucket: "artifacts",
        database: db.database,
        extractor: extraction.extractor,
        now: () => NOW,
        onTransientFailure: "omit",
        openObjectStore: bucket.openObjectStore,
        openReader: async () => async () => {
          setSystemTime(new Date(READ_ENDS_AT));
          return REPORT;
        },
      });
      setSystemTime(new Date(STARTED_AT));
      return { attachments, db, extraction };
    }

    test.each([
      ["took the whole shortened deadline", SHORTENED_DEADLINE_MS],
      ["came back early under a shortened deadline", 2_000],
    ])("a limits verdict that %s is retried, not stored", async (_name, extractionMs) => {
      const { attachments, db, extraction } = lateCapture(extractionMs);

      expect((await attachments.prepare({ ...capture, candidates: report })).omitted).toEqual([
        { artifactId: REPORT_ID, reason: "budget_exhausted" },
      ]);
      expect(extraction.requests.map(({ deadlineMs }) => deadlineMs)).toEqual([
        SHORTENED_DEADLINE_MS,
      ]);
      expect((await db.artifact(REPORT_ID))?.data.status).toBe("pending");
    });
  });

  test("a limits verdict under the full extraction deadline is stored", async () => {
    const { attachments, db, extraction } = setup(
      { "report.pdf": REPORT },
      {
        respond: async () => ({
          detail: "out of time",
          reason: "limits_exceeded",
          status: "unusable",
        }),
      },
    );

    expect((await attachments.prepare({ ...capture, candidates: report })).omitted).toEqual([]);
    expect(extraction.requests.map(({ deadlineMs }) => deadlineMs)).toEqual([
      INGRESS_ATTACHMENT_EXTRACTION_DEADLINE_MS,
    ]);
    expect((await db.artifact(REPORT_ID))?.data.input).toEqual({
      detail: "out of time",
      kind: "unusable",
      reason: "limits_exceeded",
    });
  });
});
