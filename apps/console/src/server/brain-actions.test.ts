import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attemptAfterFailure } from "../components/keyed-attempt.ts";
import { PlatformApiError } from "../errors.ts";
import { askBrains, searchBrains, uploadBrainDocument } from "./brain-actions.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const ORG = "01K0000000000000000000000A";
const BRAIN = "01K0000000000000000000000D";
const SOURCE = "01K0000000000000000000000E";
const TICKET = "01K0000000000000000000000F";
const DOCUMENT = "01K0000000000000000000000G";
const AT = "2026-10-09T12:00:00.000Z";
const FILE = "# Handbook\n";
const HASH = `sha256:${createHash("sha256").update(FILE).digest("hex")}`;
const SOURCE_PATH = `/v1/brains/${BRAIN}/sources/${SOURCE}`;
const TICKET_PATH = `${SOURCE_PATH}/uploads/${TICKET}`;

type TicketStatus = "completed" | "consumed" | "expired" | "issued" | "rejected" | "streaming";

const ticket = (status: TicketStatus) => ({
  brainId: BRAIN,
  createdAt: AT,
  expectedByteSize: FILE.length,
  expectedContentHash: HASH,
  expiresAt: new Date(Date.now() + 240_000).toISOString(),
  id: TICKET,
  mediaType: "text/markdown",
  organizationId: ORG,
  sourceId: SOURCE,
  status,
  updatedAt: AT,
  version: 0,
});

const captured = {
  document: {
    brainId: BRAIN,
    createdAt: AT,
    currentContentVersionId: TICKET,
    currentVersionId: TICKET,
    externalItemIdentity: "handbook.md",
    id: DOCUMENT,
    lifecycle: "active",
    organizationId: ORG,
    projectionGeneration: 0,
    reviewStatus: "unreviewed",
    sensitivity: "internal",
    sourceId: SOURCE,
    updatedAt: AT,
    version: 0,
  },
  version: {
    brainId: BRAIN,
    createdAt: AT,
    documentId: DOCUMENT,
    envelopeHash: "e1",
    id: TICKET,
    kind: "content",
    organizationId: ORG,
    sourceId: SOURCE,
    sourceOrder: 0,
  },
};

interface Sent {
  readonly body: string;
  readonly contentType: string | null;
  readonly environment: string | null;
  readonly key: string | null;
  readonly project: string | null;
  readonly route: string;
}

function platform(answer: (route: string) => Response | undefined) {
  const sent: Sent[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const route = `${request.method} ${new URL(request.url).pathname}`;
      sent.push({
        body: await request.text(),
        contentType: request.headers.get("content-type"),
        environment: request.headers.get("x-deployments-environment"),
        key: request.headers.get("idempotency-key"),
        project: request.headers.get("x-deployments-project"),
        route,
      });
      const response = answer(route);
      if (!response) throw new TypeError("fetch failed");
      return response;
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

const upload = (retry: boolean) => ({
  accessToken: "token",
  brainId: BRAIN,
  contentBase64: Buffer.from(FILE).toString("base64"),
  externalItemIdentity: "handbook.md",
  idempotencyKey: "k1",
  mediaType: "text/markdown",
  organizationId: ORG,
  retry,
  sourceId: SOURCE,
  title: "Handbook",
});

const routes = (sent: readonly Sent[]) => sent.map(({ key, route }) => `${route} ${key}`);

describe("uploadBrainDocument", () => {
  test("issues a ticket for the file's size and hash, streams it raw, and captures it", async () => {
    const { client, sent } = platform((route) =>
      route.startsWith("PUT")
        ? Response.json(ticket("completed"))
        : route.endsWith("/documents")
          ? Response.json(captured, { status: 201 })
          : Response.json(ticket("issued"), { status: 201 }),
    );
    const result = await uploadBrainDocument(upload(false), client);
    expect(result).toEqual({ documentId: DOCUMENT, documentVersionId: TICKET });
    expect(routes(sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `PUT ${TICKET_PATH}/content k1:content`,
      `POST ${SOURCE_PATH}/documents k1:capture`,
    ]);
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      expectedByteSize: FILE.length,
      expectedContentHash: HASH,
      mediaType: "text/markdown",
    });
    expect(sent[1]).toMatchObject({ body: FILE, contentType: "text/markdown" });
    expect(JSON.parse(sent[2]?.body ?? "")).toEqual({
      completedUploadTicketId: TICKET,
      externalItemIdentity: "handbook.md",
      kind: "content",
      mediaType: "text/markdown",
      title: "Handbook",
    });
  });

  test("a retry reads the ticket and captures a file already stored", async () => {
    const { client, sent } = platform((route) =>
      route.startsWith("GET")
        ? Response.json(ticket("completed"))
        : route.endsWith("/documents")
          ? Response.json(captured, { status: 201 })
          : Response.json(ticket("issued"), { status: 201 }),
    );
    await uploadBrainDocument(upload(true), client);
    expect(routes(sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `GET ${TICKET_PATH} null`,
      `POST ${SOURCE_PATH}/documents k1:capture`,
    ]);
  });

  test("a retry after a refused body acts on the live ticket, not the replayed one", async () => {
    const { client, sent } = platform((route) =>
      route.startsWith("PUT")
        ? Response.json(
            { code: "brain_upload_ticket_not_found", status: 404, title: "Not found" },
            { status: 404 },
          )
        : route.startsWith("GET")
          ? Response.json(ticket("completed"))
          : route.endsWith("/documents")
            ? Response.json(captured, { status: 201 })
            : Response.json(ticket("issued"), { status: 201 }),
    );
    const reread = attemptAfterFailure(
      { key: "k1", state: "resend" },
      new PlatformApiError("captureBrainDocument", { status: 422, title: "Invalid title" }),
    );
    expect(reread).toEqual({ key: "k1", state: "reread" });
    const result = await uploadBrainDocument(upload(true), client);
    expect(result).toEqual({ documentId: DOCUMENT, documentVersionId: TICKET });
    expect(routes(sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `GET ${TICKET_PATH} null`,
      `POST ${SOURCE_PATH}/documents k1:capture`,
    ]);
  });

  test("a PUT lost after the file was stored goes on to capture", async () => {
    const { client, sent } = platform((route) =>
      route.startsWith("PUT")
        ? Response.json({ status: 502, title: "Bad gateway" }, { status: 502 })
        : route.startsWith("GET")
          ? Response.json(ticket("completed"))
          : route.endsWith("/documents")
            ? Response.json(captured, { status: 201 })
            : Response.json(ticket("issued"), { status: 201 }),
    );
    await uploadBrainDocument(upload(false), client);
    expect(routes(sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `PUT ${TICKET_PATH}/content k1:content`,
      `GET ${TICKET_PATH} null`,
      `POST ${SOURCE_PATH}/documents k1:capture`,
    ]);
  });

  test("a ticket left streaming restarts the upload under a new key", async () => {
    const { client, sent } = platform((route) =>
      route.startsWith("PUT")
        ? undefined
        : route.startsWith("GET")
          ? Response.json(ticket("streaming"))
          : Response.json(ticket("issued"), { status: 201 }),
    );
    const failure = await uploadBrainDocument(upload(false), client).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatformApiError);
    expect(failure).toMatchObject({ problem: { code: "brain_upload_restart", status: 409 } });
    expect(routes(sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `PUT ${TICKET_PATH}/content k1:content`,
      `GET ${TICKET_PATH} null`,
    ]);
    const next = attemptAfterFailure({ key: "k1", state: "resend" }, failure);
    expect(next.state).toBe("fresh");
    expect(next.key).not.toBe("k1");

    const resent = platform((route) =>
      route.startsWith("GET")
        ? Response.json(ticket("streaming"))
        : Response.json(ticket("issued"), { status: 201 }),
    );
    const again = await uploadBrainDocument(upload(true), resent.client).catch(
      (error: unknown) => error,
    );
    expect(again).toMatchObject({ problem: { code: "brain_upload_restart" } });
    expect(routes(resent.sent)).toEqual([
      `POST ${SOURCE_PATH}/uploads k1:ticket`,
      `GET ${TICKET_PATH} null`,
    ]);
  });

  test("a file over the console's cap never reaches the platform", async () => {
    const { client, sent } = platform(() => Response.json(ticket("issued")));
    const oversized = {
      ...upload(false),
      contentBase64: Buffer.alloc(3_362_713).toString("base64"),
    };
    const failure = await uploadBrainDocument(oversized, client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
  });
});

const SCOPE = {
  environmentId: "01K0000000000000000000000C",
  organizationId: ORG,
  projectId: "01K0000000000000000000000B",
};
const ATTEMPT = "01K0000000000000000000000H";
const citation = {
  brainId: BRAIN,
  chunkId: "chunk-1",
  coordinates: { end: 40, kind: "utf8-byte", start: 0 },
  documentId: DOCUMENT,
  documentVersionId: TICKET,
  renditionId: "01K0000000000000000000000J",
  sourceId: SOURCE,
};

describe("searchBrains and askBrains", () => {
  test("search sends the environment scope and a fresh key, and tags the results", async () => {
    const results = {
      queryAttemptId: ATTEMPT,
      results: [{ citation, excerpt: "Rotate keys weekly.", score: 0.82, sensitivity: "internal" }],
    };
    const { client, sent } = platform(() => Response.json(results));
    const result = await searchBrains(
      {
        accessToken: "token",
        body: { brainIds: [BRAIN], query: "key rotation" },
        idempotencyKey: "q1",
        scope: SCOPE,
      },
      client,
    );
    expect<unknown>(result).toEqual({ mode: "search", results });
    expect(
      sent.map(({ environment, key, project, route }) => [route, key, project, environment]),
    ).toEqual([["POST /v1/brains/search", "q1", SCOPE.projectId, SCOPE.environmentId]]);
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({ brainIds: [BRAIN], query: "key rotation" });
  });

  test("ask tags the answer", async () => {
    const answer = {
      claims: [{ citationIds: ["x"], text: "Keys rotate weekly." }],
      gaps: [],
      queryAttemptId: ATTEMPT,
      usedCitations: [citation],
    };
    const { client } = platform(() => Response.json(answer));
    const result = await askBrains(
      {
        accessToken: "token",
        body: { brainIds: [BRAIN], question: "How often do keys rotate?" },
        idempotencyKey: "q2",
        scope: SCOPE,
      },
      client,
    );
    expect<unknown>(result).toEqual({ answer, mode: "ask" });
  });

  test("more than 20 Brains or a repeated Brain never reaches the platform", async () => {
    const { client, sent } = platform(() => Response.json({}));
    const tooMany = Array.from(
      { length: 21 },
      (_, index) => `01K00000000000000000000${String(index).padStart(3, "0")}`,
    );
    const failures = await Promise.all(
      [tooMany, [BRAIN, BRAIN]].map((brainIds) =>
        searchBrains(
          {
            accessToken: "token",
            body: { brainIds, query: "q" },
            idempotencyKey: "q3",
            scope: SCOPE,
          },
          client,
        ).catch((error: unknown) =>
          error instanceof PlatformApiError ? error.problem.status : error,
        ),
      ),
    );
    expect(failures).toEqual([400, 400]);
    expect(sent).toEqual([]);
  });
});
