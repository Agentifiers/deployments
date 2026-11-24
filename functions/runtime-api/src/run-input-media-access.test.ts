import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createConversationService } from "@deployments-ai/conversations";
import {
  ArtifactRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  Ulid,
  withCanonicalRecordKeys,
  type ArtifactInputFile,
  type ArtifactOwner,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  apiKey,
  apiKeyRecords,
  environmentRecords,
  humanId,
  humanPrincipal,
  membership,
  runtimeApiClient,
  startJwtIssuer,
  tenantHeaders,
  type JwtIssuer,
} from "./runtime-human-access.fixture.ts";
import {
  deployment,
  deploymentId,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  release,
  runLocator,
  runRecord,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";

const otherPersonId = ids[29]!;
const threadId = ids[8]!;
const otherThreadId = ids[9]!;
const personScopes = "runs:read runs:write artifacts:read";
const person = { principalId: humanId, type: "principal" } as const;

let jwt: JwtIssuer;

beforeAll(async () => {
  jwt = await startJwtIssuer();
});

afterAll(async () => {
  await jwt.stop();
});

function threadRecord(id: Ulid) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: humanId, type: "principal" as const },
        environmentId,
        id,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Screenshot questions",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

function inputFile(
  id: Ulid,
  owner: ArtifactOwner,
  file: { readonly input: ArtifactInputFile; readonly name: string; readonly contentType: string },
  boundThreadId: Ulid = threadId,
) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        id,
        input: file.input,
        name: file.name,
        organizationId,
        owner,
        projectId,
        status: "available" as const,
        storage: {
          bucket: "private-artifacts",
          byteSize: 100,
          contentType: file.contentType,
          key: `customer/${id}`,
          sha256: "a".repeat(64),
          versionId: "v1",
        },
        threadId: boundThreadId,
        type: "input",
        updatedAt: now.toISOString(),
        version: 0,
        visibility: "private" as const,
      },
      itemType: "artifact" as const,
    }),
  );
}

const png = {
  contentType: "image/png",
  input: { kind: "image", mediaType: "image/png" },
  name: "error.png",
} as const;
const image = (id: Ulid, owner: ArtifactOwner, boundThreadId: Ulid = threadId) =>
  inputFile(id, owner, png, boundThreadId);
const csv = inputFile(ids[27]!, person, {
  contentType: "text/csv",
  input: {
    kind: "document",
    mediaType: "text/csv",
    summary: "CSV file, 2 rows",
    text: {
      byteSize: 32,
      extractor: "document-text-v1",
      sha256: "b".repeat(64),
      truncated: false,
      versionId: "text-v1",
    },
  },
  name: "q3.csv",
});
const scan = inputFile(ids[28]!, person, {
  contentType: "application/pdf",
  input: { kind: "unusable", reason: "no_text" },
  name: "scan.pdf",
});

function releaseWithModel(modelId: string, runtime: { readonly ingressAttachments?: "attach" }) {
  const base = release();
  return {
    ...base,
    data: {
      ...base.data,
      manifest: {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: "media.test-agent", name: "Media Test Agent", version: "1.0.0" },
        spec: {
          instructions: "Describe what the image shows.",
          model: { id: modelId },
          runtime,
          sandbox: { mode: "none" },
        },
      },
    },
  } as unknown as PlatformRecord;
}

const ownImage = image(ids[20]!, person);
const otherPersonImage = image(ids[21]!, { principalId: otherPersonId, type: "principal" });
const serviceAccountImage = image(ids[22]!, { serviceAccountId, type: "service-account" });
const otherThreadImage = image(ids[23]!, person, otherThreadId);

function failedPersonMediaRun() {
  const base = runRecord("failed");
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...base.data,
        initiatingCaller: { principalId: humanId, scopes: ["runs:write"], type: "principal" },
        inputArtifacts: [ownImage.data.id],
      },
      itemType: "run" as const,
    }),
  );
}

function promptMessage(run: Extract<PlatformRecord, { readonly itemType: "run" }>) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        body: "What does this error say?",
        contentHash: "prompt-hash",
        createdAt: now.toISOString(),
        environmentId,
        id: run.data.userMessageId!,
        inputArtifacts: [ownImage.data.id],
        organizationId,
        projectId,
        role: "user" as const,
        runId: run.data.id,
        sequence: run.data.userMessageSequence!,
        threadId: run.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

function fixture(
  records: readonly PlatformRecord[] = [],
  modelId = "openrouter/qwen/qwen3.7-plus",
  runtime: { readonly ingressAttachments?: "attach" } = {},
) {
  const memory = memoryDatabase([
    deployment(),
    releaseWithModel(modelId, runtime),
    threadRecord(threadId),
    threadRecord(otherThreadId),
    ownImage,
    otherPersonImage,
    serviceAccountImage,
    otherThreadImage,
    humanPrincipal(humanId),
    humanPrincipal(otherPersonId),
    membership("admin"),
    membership("admin", "active", otherPersonId),
    ...environmentRecords(environmentId, organizationId, projectId),
    ...apiKeyRecords(["runs:read", "runs:write", "artifacts:read"]),
    ...records,
  ]);
  const { request } = runtimeApiClient(memory.database, jwt.issuer);
  const submit = async (bearer: string, inputArtifacts: readonly string[]) =>
    request("POST", `/v1/agent-deployments/${deploymentId}/runs`, bearer, {
      body: { content: "What does this error say?", inputArtifacts, threadId },
      headers: { ...tenantHeaders, "idempotency-key": `submit-${inputArtifacts.join("-")}` },
    });
  const storedRuns = () =>
    [...memory.records.values()].flatMap((record) =>
      record.itemType === "run" ? [record.data] : [],
    );
  return { memory, request, storedRuns, submit };
}

const personCaller = expect.objectContaining({ principalId: humanId, type: "principal" });

describe("people attach their own media to runs", () => {
  test("a person submits a run with their own image on the same thread", async () => {
    const f = fixture();

    const submitted = await f.submit(await jwt.token({ scope: personScopes }), [ownImage.data.id]);

    expect(submitted).toMatchObject({
      body: { message: { inputArtifacts: [ownImage.data.id] } },
      status: 202,
    });
    expect(f.storedRuns()).toEqual([
      expect.objectContaining({
        initiatingCaller: personCaller,
        inputArtifacts: [ownImage.data.id],
      }),
    ]);
  });

  test("another person's, a service account's, or another thread's artifact is 404", async () => {
    const f = fixture();
    const bearer = await jwt.token({ scope: personScopes });

    for (const artifact of [otherPersonImage, serviceAccountImage, otherThreadImage]) {
      expect(await f.submit(bearer, [artifact.data.id])).toMatchObject({
        body: { code: "input_artifact_unavailable" },
        status: 404,
      });
    }
  });

  test("the initiating person retries and replays; another person and a service account get 404", async () => {
    const run = failedPersonMediaRun();
    const f = fixture([run, runLocator(run), promptMessage(run)]);
    const owner = await jwt.token({ scope: personScopes });
    const otherPerson = await jwt.token({ scope: personScopes, subject: otherPersonId });

    for (const [bearer, headers] of [
      [otherPerson, tenantHeaders],
      [apiKey, {}],
    ] as const) {
      for (const operation of ["retry", "replay"]) {
        expect(
          await f.request("POST", `/v1/runs/${run.data.id}/${operation}`, bearer, {
            headers: { ...headers, "idempotency-key": `${operation}-foreign` },
          }),
        ).toMatchObject({ body: { code: "input_artifact_unavailable" }, status: 404 });
      }
    }

    const replayed = await f.request("POST", `/v1/runs/${run.data.id}/replay`, owner, {
      headers: { ...tenantHeaders, "idempotency-key": "replay-own-image" },
    });
    expect(replayed.status).toBe(202);
    expect(f.storedRuns()).toContainEqual(
      expect.objectContaining({
        initiatingCaller: personCaller,
        inputArtifacts: [ownImage.data.id],
        replayedFromRunId: run.data.id,
      }),
    );
    const retried = await f.request("POST", `/v1/runs/${run.data.id}/retry`, owner);
    expect(retried).toMatchObject({ body: { id: run.data.id, status: "queued" }, status: 202 });
  });

  test("an image on a release whose model cannot read images is refused with 422", async () => {
    const f = fixture([], "openrouter/z-ai/glm-5.2");

    expect(
      await f.submit(await jwt.token({ scope: personScopes }), [ownImage.data.id]),
    ).toMatchObject({ body: { code: "model_image_input_unsupported" }, status: 422 });
    expect(f.storedRuns()).toEqual([]);
  });

  test("a file that can't be used is refused with 422 naming it", async () => {
    const f = fixture([scan]);

    expect(await f.submit(await jwt.token({ scope: personScopes }), [scan.data.id])).toMatchObject({
      body: {
        code: "input_file_no_text",
        detail: `Input file ${scan.data.id} (scan.pdf) can't be used: the file has no readable text. If it is a scan, OCR found no text or isn't turned on.`,
      },
      status: 422,
    });
    expect(f.storedRuns()).toEqual([]);
  });

  test("an input upload that completed before resolution existed is 404", async () => {
    const { input: _resolution, ...uploadedBeforeResolution } = image(ids[30]!, person).data;
    const unresolved = Schema.decodeUnknownSync(ArtifactRecord)(
      withCanonicalRecordKeys({ data: uploadedBeforeResolution, itemType: "artifact" as const }),
    );
    const f = fixture([unresolved]);

    expect(
      await f.submit(await jwt.token({ scope: personScopes }), [unresolved.data.id]),
    ).toMatchObject({ body: { code: "input_artifact_unavailable" }, status: 404 });
    expect(f.storedRuns()).toEqual([]);
  });

  test("a release whose model cannot read images accepts a document-only run", async () => {
    const f = fixture([csv], "openrouter/z-ai/glm-5.2");

    expect(await f.submit(await jwt.token({ scope: personScopes }), [csv.data.id])).toMatchObject({
      body: { message: { inputArtifacts: [csv.data.id] } },
      status: 202,
    });
    expect(f.storedRuns()).toEqual([
      expect.objectContaining({ initiatingCaller: personCaller, inputArtifacts: [csv.data.id] }),
    ]);
  });

  test("retry and replay of an ingress media run are 404 to a person and to a service account", async () => {
    const source = {
      sourceId: ids[24]!,
      sourceKind: "agent-email-binding",
      type: "ingress",
    } as const;
    const emailThreadId = ids[25]!;
    const emailImage = image(ids[26]!, source, emailThreadId);
    const f = fixture([emailImage], "openrouter/qwen/qwen3.7-plus", {
      ingressAttachments: "attach",
    });
    let nextId = 200;
    const { run } = await createConversationService({
      database: f.memory.database,
      enqueueRun: async () => {},
      generateId: async () =>
        Schema.decodeUnknownSync(Ulid)(
          `01ARZ3NDEKTSV4RRFFQ69G${String(nextId++).padStart(4, "0")}`,
        ),
      now: () => now,
    }).submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      channel: "email",
      content: "What does this error say?",
      createThreadIfMissing: true,
      environmentId,
      idempotencyKey: "email-message-1",
      initiatingCaller: source,
      inputArtifacts: [emailImage.data.id],
      organizationId,
      projectId,
      threadId: emailThreadId,
      trigger: "email",
    });
    const failed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...run.data, completedAt: now.toISOString(), status: "failed" as const },
        itemType: "run" as const,
      }),
    );
    await f.memory.database.transactWrite([
      { kind: "put", record: failed },
      { kind: "put", record: runLocator(failed) },
    ]);
    const person = await jwt.token({ scope: personScopes });

    expect(failed.data.inputArtifacts).toEqual([emailImage.data.id]);
    for (const [bearer, headers] of [
      [person, tenantHeaders],
      [apiKey, {}],
    ] as const) {
      for (const operation of ["retry", "replay"]) {
        expect(
          await f.request("POST", `/v1/runs/${run.data.id}/${operation}`, bearer, {
            headers: { ...headers, "idempotency-key": `${operation}-ingress` },
          }),
        ).toMatchObject({ body: { code: "input_artifact_unavailable" }, status: 404 });
      }
    }
  });
});
