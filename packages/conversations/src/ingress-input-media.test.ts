import { MAX_INPUT_ARTIFACT_BYTES } from "@deployments-ai/agent-manifest";
import type {
  ArtifactInputFile,
  ArtifactOwner,
  PlatformRecord,
  RunInitiatingCaller,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  inputArtifact,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import { createConversationService } from "./index.ts";

const source = { sourceId: ids[30]!, sourceKind: "channel-binding", type: "ingress" } as const;
const reservedThreadId = ids[32]!;
const serviceAccount = {
  apiCredentialId: ids[29]!,
  serviceAccountId: ids[28]!,
  type: "service-account",
} as const;
const serviceAccountOwner = { serviceAccountId: ids[28]!, type: "service-account" } as const;
const attach = { ingressAttachments: "attach" } as const;
const [photoId, voiceNoteId, otherSourcePhotoId, missingId, documentId, scanId, secondScanId] = [
  ids[33]!,
  ids[34]!,
  ids[35]!,
  ids[36]!,
  ids[37]!,
  ids[38]!,
  ids[39]!,
];
const reportId = ids[27]!;
const FILE_NAMES: Readonly<Record<string, string>> = {
  [documentId]: "scan.pdf",
  [photoId]: "photo.png",
  [reportId]: "q3.csv",
  [secondScanId]: "second-scan.jpg",
  [voiceNoteId]: "voice-note.wav",
};

function artifact(
  id: (typeof ids)[number],
  contentType: string,
  owner: ArtifactOwner = source,
  byteSize = 100,
  input?: ArtifactInputFile,
) {
  return inputArtifact({
    byteSize,
    contentType,
    id,
    ...(input ? { input } : {}),
    ...(FILE_NAMES[id] ? { name: FILE_NAMES[id] } : {}),
    owner,
    threadId: reservedThreadId,
  });
}

function conversationsWith(
  options: Parameters<typeof controlFixtures>[0],
  artifacts: readonly PlatformRecord[],
) {
  const fixtures = controlFixtures(options);
  const memory = memoryDatabase([fixtures.deployment, fixtures.release, ...artifacts]);
  const conversations = createConversationService({
    database: memory.database,
    enqueueRun: async () => {},
    generateId: idGenerator(),
    now: () => now,
  });
  return { conversations, memory };
}

function channelTurn(inputArtifacts: readonly string[], caller: RunInitiatingCaller = source) {
  return {
    actor:
      caller.type === "service-account"
        ? { id: caller.serviceAccountId, type: "service-account" as const }
        : { type: "system" as const },
    agentDeploymentId: deploymentId,
    channel: "telegram",
    content: "What is in this photo?",
    createThreadIfMissing: true,
    environmentId,
    externalThreadKey: "telegram-chat-1",
    idempotencyKey: "telegram-message-1",
    initiatingCaller: caller,
    ...(inputArtifacts.length > 0 ? { inputArtifacts } : {}),
    organizationId,
    projectId,
    threadId: reservedThreadId,
    trigger: "chat",
  };
}

describe("ingress input media", () => {
  test("an ingress turn on a reserved, not-yet-created thread attaches its source's artifacts", async () => {
    const { conversations } = conversationsWith({ runtime: attach }, [
      artifact(photoId, "image/png"),
    ]);

    const created = await conversations.submitTurn(channelTurn([photoId]));

    expect(created).toMatchObject({
      created: true,
      message: { data: { inputArtifacts: [photoId] } },
      omittedInputArtifacts: [],
      run: { data: { initiatingCaller: source, inputArtifacts: [photoId], status: "queued" } },
      thread: { data: { id: reservedThreadId } },
    });
  });

  test("an ingress turn omits other-owner, missing, unusable, and over-aggregate files, names them to the model, and still runs", async () => {
    const { conversations } = conversationsWith({ runtime: attach }, [
      artifact(photoId, "image/png"),
      artifact(otherSourcePhotoId, "image/png", { ...source, sourceId: ids[31]! }),
      artifact(documentId, "application/pdf", source, 100, { kind: "unusable", reason: "no_text" }),
      artifact(reportId, "text/csv", source, MAX_INPUT_ARTIFACT_BYTES),
      artifact(scanId, "image/jpeg", source, MAX_INPUT_ARTIFACT_BYTES),
      artifact(secondScanId, "image/jpeg", source, MAX_INPUT_ARTIFACT_BYTES),
    ]);

    const created = await conversations.submitTurn(
      channelTurn([
        photoId,
        otherSourcePhotoId,
        missingId,
        documentId,
        reportId,
        scanId,
        secondScanId,
      ]),
    );

    expect(created).toMatchObject({
      created: true,
      message: {
        data: {
          inputArtifacts: [photoId, reportId, scanId],
          inputOmissions: [
            { name: "scan.pdf", reason: "no_text" },
            { name: "second-scan.jpg", reason: "over_turn_cap" },
          ],
        },
      },
      omittedInputArtifacts: [
        { artifactId: otherSourcePhotoId, reason: "input_artifact_unavailable" },
        { artifactId: missingId, reason: "input_artifact_unavailable" },
        { artifactId: documentId, reason: "input_file_no_text" },
        { artifactId: secondScanId, reason: "aggregate_limit" },
      ],
      run: { data: { inputArtifacts: [photoId, reportId, scanId], status: "queued" } },
    });
  });

  test("an ingress turn omits every attachment when the selected release did not opt in", async () => {
    const { conversations } = conversationsWith({}, [
      artifact(photoId, "image/png"),
      artifact(voiceNoteId, "audio/wav"),
    ]);

    const created = await conversations.submitTurn({
      ...channelTurn([photoId, voiceNoteId, otherSourcePhotoId]),
      skippedInputFiles: [{ name: "budget.xls", reason: "legacy_office_format" }],
    });

    expect(created).toMatchObject({
      created: true,
      message: {
        data: {
          inputOmissions: [
            { name: "photo.png", reason: "attachments_disabled" },
            { name: "voice-note.wav", reason: "attachments_disabled" },
            { name: "budget.xls", reason: "attachments_disabled" },
          ],
        },
      },
      omittedInputArtifacts: [
        { artifactId: photoId, reason: "ingress_attachments_disabled" },
        { artifactId: voiceNoteId, reason: "ingress_attachments_disabled" },
        { artifactId: otherSourcePhotoId, reason: "ingress_attachments_disabled" },
      ],
      run: { data: { status: "queued" } },
    });
    expect(created.run.data.inputArtifacts).toBeUndefined();
    expect(created.message.data.inputArtifacts).toBeUndefined();
  });

  test("files ingress skipped are named after the files admission left out, eight at most, and the rest are counted", async () => {
    const { conversations } = conversationsWith({ runtime: attach }, [
      artifact(photoId, "image/png"),
      artifact(documentId, "application/pdf", source, 100, { kind: "unusable", reason: "no_text" }),
    ]);

    const created = await conversations.submitTurn({
      ...channelTurn([photoId, documentId]),
      skippedInputFiles: [
        { name: "budget.xls", reason: "legacy_office_format" },
        { name: "board-pack.pdf", reason: "too_large" },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((deck) => ({
          name: `deck-${deck}.pptx`,
          reason: "unsupported_type" as const,
        })),
      ],
    });

    expect(created).toMatchObject({ created: true, run: { data: { inputArtifacts: [photoId] } } });
    expect(created.message.data.inputOmissions).toEqual([
      { name: "scan.pdf", reason: "no_text" },
      { name: "budget.xls", reason: "legacy_office_format" },
      { name: "board-pack.pdf", reason: "too_large" },
      { name: "deck-1.pptx", reason: "unsupported_type" },
      { name: "deck-2.pptx", reason: "unsupported_type" },
      { name: "deck-3.pptx", reason: "unsupported_type" },
      { name: "deck-4.pptx", reason: "unsupported_type" },
      { name: "deck-5.pptx", reason: "unsupported_type" },
    ]);
    expect(created.message.data.unlistedInputOmissions).toBe(3);
  });

  test("a turn whose every attachment was skipped still names them, and only that same list from ingress reconciles", async () => {
    const { conversations } = conversationsWith({ runtime: attach }, [
      artifact(voiceNoteId, "audio/wav", serviceAccountOwner),
    ]);
    const turn = {
      ...channelTurn([]),
      skippedInputFiles: [{ name: "contract.doc", reason: "legacy_office_format" as const }],
    };

    const first = await conversations.submitTurn(turn);
    const redelivered = await conversations.submitTurn(turn);

    expect(first).toMatchObject({
      created: true,
      message: {
        data: { inputOmissions: [{ name: "contract.doc", reason: "legacy_office_format" }] },
      },
      omittedInputArtifacts: [],
    });
    expect(first.run.data.inputArtifacts).toBeUndefined();
    expect(redelivered).toMatchObject({ created: false, run: { data: { id: first.run.data.id } } });
    expect(
      conversations.submitTurn({
        ...turn,
        skippedInputFiles: [{ name: "contract.doc", reason: "too_large" }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      conversations.submitTurn({
        ...channelTurn([voiceNoteId], serviceAccount),
        idempotencyKey: "service-account-turn",
        skippedInputFiles: turn.skippedInputFiles,
      }),
    ).rejects.toMatchObject({ code: "invalid_input_artifacts" });
  });

  test("an ingress turn omits images the primary cannot read and keeps audio, while a service account sending the same list is refused", async () => {
    for (const [modelId, reason] of [
      ["openrouter/z-ai/glm-5.2", "model_image_input_unsupported"],
      ["openrouter/vendor/operator-granted", "model_image_input_unknown"],
    ] as const) {
      const options = { model: { id: modelId }, runtime: attach };
      const ingress = conversationsWith(options, [
        artifact(photoId, "image/png"),
        artifact(voiceNoteId, "audio/wav"),
      ]);

      const offered = await ingress.conversations.submitTurn(channelTurn([photoId, voiceNoteId]));

      expect(offered).toMatchObject({
        created: true,
        message: {
          data: { inputOmissions: [{ name: "photo.png", reason: "images_unsupported" }] },
        },
        omittedInputArtifacts: [{ artifactId: photoId, reason }],
        run: { data: { inputArtifacts: [voiceNoteId], status: "queued" } },
      });
      const api = conversationsWith(options, [
        artifact(photoId, "image/png", serviceAccountOwner),
        artifact(voiceNoteId, "audio/wav", serviceAccountOwner),
      ]);
      expect(
        api.conversations.submitTurn(channelTurn([photoId, voiceNoteId], serviceAccount)),
      ).rejects.toMatchObject({ code: reason });
    }
  });

  test("the same offered list redelivered reconciles to the same run, including after an omission", async () => {
    const { conversations, memory } = conversationsWith({ runtime: attach }, [
      artifact(photoId, "image/png"),
    ]);
    const first = await conversations.submitTurn(channelTurn([photoId, scanId]));
    memory.put(artifact(scanId, "image/jpeg"));

    const redelivered = await conversations.submitTurn(channelTurn([photoId, scanId]));

    expect(first).toMatchObject({
      created: true,
      omittedInputArtifacts: [{ artifactId: scanId, reason: "input_artifact_unavailable" }],
    });
    expect(redelivered).toMatchObject({
      created: false,
      run: { data: { id: first.run.data.id, inputArtifacts: [photoId] } },
    });
  });
});
