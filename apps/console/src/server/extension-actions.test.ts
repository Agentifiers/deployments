import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { createExtension, updateExtension } from "./extension-actions.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const scope = {
  environmentId: "01K0000000000000000000000C",
  organizationId: "01K0000000000000000000000A",
  projectId: "01K0000000000000000000000B",
};
const HASH = `sha256:${"b".repeat(64)}`;
const SOURCE = "export async function handler() {\n  return {};\n}\n";

const artifact = {
  byteSize: 40,
  contentHash: HASH,
  createdAt: "2026-10-07T00:00:00.000Z",
  language: "javascript",
  sourceByteSize: 48,
  sourceContentHash: `sha256:${"c".repeat(64)}`,
  sourceLanguage: "typescript",
};

const extension = {
  createdAt: "2026-10-07T00:00:00.000Z",
  defaultPolicyAction: "allow",
  description: "Totals invoice lines.",
  effect: "read",
  execution: {
    contentHash: HASH,
    entrypoint: "handler",
    language: "javascript",
    memoryMiB: 256,
    network: "none",
    secretNames: [],
    sourceLanguage: "typescript",
    timeoutMs: 30_000,
    type: "hosted_code",
  },
  hasCallbackAuth: false,
  id: "01K0000000000000000000000D",
  inputSchema: { type: "object" },
  name: "invoice.total",
  outputSchema: { type: "object" },
  requiredScopes: [],
  status: "active",
  updatedAt: "2026-10-07T00:00:00.000Z",
  version: 0,
};

const hostedBody = {
  defaultPolicyAction: "allow",
  description: "Totals invoice lines.",
  effect: "read",
  execution: { network: "none", type: "hosted_code" },
  inputSchema: { type: "object" },
  name: "invoice.total",
  outputSchema: { type: "object" },
  requiredScopes: [],
};

interface Sent {
  readonly body: unknown;
  readonly key: string | null;
  readonly method: string;
  readonly path: string;
}

function platform(respond: (path: string) => Response) {
  const sent: Sent[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      sent.push({
        body: await request.json(),
        key: request.headers.get("idempotency-key"),
        method: request.method,
        path,
      });
      return respond(path);
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

function succeed(path: string) {
  return Response.json(path === "/v1/hosted-code-artifacts" ? artifact : extension, {
    status: 201,
  });
}

describe("createExtension", () => {
  test("uploads new source, then creates the extension on the uploaded artifact", async () => {
    const { client, sent } = platform(succeed);
    const created = await createExtension(
      {
        accessToken: "token",
        artifact: { language: "typescript", source: SOURCE },
        body: hostedBody,
        idempotencyKey: "dialog-key",
        scope,
      },
      client,
    );
    expect<unknown>(created).toEqual({ id: "01K0000000000000000000000D", name: "invoice.total" });
    expect(sent).toEqual([
      {
        body: { language: "typescript", source: SOURCE },
        key: "dialog-key:artifact",
        method: "POST",
        path: "/v1/hosted-code-artifacts",
      },
      {
        body: {
          ...hostedBody,
          execution: { contentHash: HASH, network: "none", type: "hosted_code" },
        },
        key: "dialog-key:extension",
        method: "POST",
        path: "/v1/extensions",
      },
    ]);
  });

  test("a retry after the second step failed resends both steps with the same keys", async () => {
    let failed = false;
    const { client, sent } = platform((path) => {
      if (path === "/v1/extensions" && !failed) {
        failed = true;
        return Response.json({ status: 500, title: "Internal error" }, { status: 500 });
      }
      return succeed(path);
    });
    const write = {
      accessToken: "token",
      artifact: { language: "typescript", source: SOURCE },
      body: hostedBody,
      idempotencyKey: "dialog-key",
      scope,
    };
    const failure = await createExtension(write, client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformApiError);
    await createExtension(write, client);
    expect(sent.map(({ key, path }) => `${key} ${path}`)).toEqual([
      "dialog-key:artifact /v1/hosted-code-artifacts",
      "dialog-key:extension /v1/extensions",
      "dialog-key:artifact /v1/hosted-code-artifacts",
      "dialog-key:extension /v1/extensions",
    ]);
  });

  test("a body the contract rejects never reaches the platform", async () => {
    const { client, sent } = platform(succeed);
    const failure = await createExtension(
      {
        accessToken: "token",
        body: { ...hostedBody, execution: { contentHash: HASH, type: "hosted_code" }, name: "" },
        idempotencyKey: "dialog-key",
        scope,
      },
      client,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      problem: { detail: "The request has an invalid value at name.", status: 400 },
    });
    expect(sent).toEqual([]);
  });
});

describe("updateExtension", () => {
  test("updates by tool name with the version it read", async () => {
    const { client, sent } = platform(() => Response.json({ ...extension, version: 4 }));
    const updated = await updateExtension(
      {
        accessToken: "token",
        body: { description: "Totals every line.", expectedVersion: 3 },
        idempotencyKey: "dialog-key",
        scope,
        toolName: "invoice.total",
      },
      client,
    );
    expect<unknown>(updated).toEqual({
      id: "01K0000000000000000000000D",
      name: "invoice.total",
      version: 4,
    });
    expect(sent).toEqual([
      {
        body: { description: "Totals every line.", expectedVersion: 3 },
        key: "dialog-key:extension",
        method: "PATCH",
        path: "/v1/extensions/invoice.total",
      },
    ]);
  });
});
