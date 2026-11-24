import {
  CreateExtensionToolRequest,
  ExtensionToolResponse,
  UpdateExtensionToolRequest,
} from "@deployments-ai/api-contract/tooling";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  blankDraft,
  createWrite,
  editDraft,
  rebaseDraft,
  updateWrite,
  type ExecutionType,
  type ExtensionDraft,
  type ExtensionTool,
  type NewDraftPrefill,
} from "./extension-draft.ts";

const SERVER_ID = "01M4CGXP4MSH02TQKZC4HB0CET";
const HASH = `sha256:${"a".repeat(64)}`;
const decodeCreate = Schema.decodeUnknownSync(CreateExtensionToolRequest);
const decodeUpdate = Schema.decodeUnknownSync(UpdateExtensionToolRequest);

function isType<Type extends ExecutionType>(
  draft: ExtensionDraft,
  type: Type,
): draft is Extract<ExtensionDraft, { readonly type: Type }> {
  return draft.type === type;
}

function draftOf<Type extends ExecutionType>(type: Type, prefill: NewDraftPrefill = {}) {
  const draft = blankDraft(type, prefill);
  if (!isType(draft, type)) throw new Error(type);
  return { ...draft, description: "Look up an order. ", name: " orders.lookup" };
}

function written(draft: ExtensionDraft) {
  const planned = createWrite(draft);
  if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
  return planned.write;
}

function tool(fields: Readonly<Record<string, unknown>>): ExtensionTool {
  return Schema.decodeUnknownSync(ExtensionToolResponse)({
    createdAt: "2026-10-07T00:00:00.000Z",
    defaultPolicyAction: "allow",
    description: "Look up an order.",
    effect: "read",
    execution: { type: "client" },
    hasCallbackAuth: false,
    id: "01M4CH02X4NAR62Q9ZQPE09C0J",
    inputSchema: { type: "object" },
    name: "orders.lookup",
    requiredScopes: [],
    status: "active",
    updatedAt: "2026-10-07T00:00:00.000Z",
    version: 3,
    ...fields,
  });
}

describe("createWrite", () => {
  test("an MCP draft is a read tool on the chosen server's remote tool", () => {
    const write = written(draftOf("mcp", { remote: "search", server: SERVER_ID }));
    expect<unknown>(decodeCreate(write.body)).toEqual({
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      effect: "read",
      execution: { mcpServerId: SERVER_ID, remoteToolName: "search", type: "mcp" },
      inputSchema: { properties: {}, type: "object" },
      name: "orders.lookup",
      requiredScopes: [],
    });
    expect(write.artifact).toBeUndefined();
  });

  test("an HTTP callback draft carries its provider, secret, scopes, and workspace files", () => {
    const draft = {
      ...draftOf("http_callback"),
      callbackSecret: { kind: "replace", value: "s3cret" },
      effect: "write",
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/orders/lookup",
      requiredScopes: "callback:context:read, callback:task:propose",
      workspaceFiles: "site/*.html\n\n  site/*.css  \n",
    } satisfies ExtensionDraft;
    expect(decodeCreate(written(draft).body)).toEqual({
      callbackSecret: "s3cret",
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      effect: "write",
      execution: {
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/orders/lookup",
        type: "http_callback",
        workspaceFiles: { include: ["site/*.html", "site/*.css"] },
      },
      inputSchema: { properties: {}, type: "object" },
      name: "orders.lookup",
      providerKey: "extension_callback",
      requiredScopes: ["callback:context:read", "callback:task:propose"],
    });
  });

  test("a client draft omits blank optional fields and keeps typed ones", () => {
    const blank = draftOf("client");
    expect(decodeCreate(written(blank).body)).toEqual({
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      effect: "read",
      execution: { type: "client" },
      inputSchema: { properties: {}, type: "object" },
      name: "orders.lookup",
      requiredScopes: [],
    });
    const typed = { ...blank, outputSchema: '{"type":"object"}', timeoutMs: " 60000 " };
    expect(written(typed).body).toMatchObject({
      execution: { timeoutMs: 60_000, type: "client" },
      outputSchema: { type: "object" },
    });
  });

  test("a hosted code draft with new source uploads it and leaves the content hash to the server", () => {
    const draft = {
      ...draftOf("hosted_code"),
      memoryMiB: "512",
      network: "sandbox",
      secrets: { entries: [{ name: "BILLING_TOKEN", value: "t0ken" }], kind: "replace" },
    } satisfies ExtensionDraft;
    const write = written(draft);
    expect(write.artifact).toEqual({
      language: "typescript",
      source: "export async function handler(input) {\n  return { ok: true };\n}\n",
    });
    expect(write.body.execution).toEqual({
      memoryMiB: 512,
      network: "sandbox",
      type: "hosted_code",
    });
    expect(
      decodeCreate({ ...write.body, execution: { ...write.body.execution, contentHash: HASH } }),
    ).toEqual({
      defaultPolicyAction: "allow",
      description: "Look up an order.",
      effect: "read",
      execution: { contentHash: HASH, memoryMiB: 512, network: "sandbox", type: "hosted_code" },
      inputSchema: { properties: {}, type: "object" },
      name: "orders.lookup",
      outputSchema: { properties: {}, type: "object" },
      requiredScopes: [],
      secrets: { BILLING_TOKEN: "t0ken" },
    });
  });

  test("a hosted code draft that keeps an artifact names its hash and uploads nothing", () => {
    const draft = {
      ...draftOf("hosted_code"),
      source: { contentHash: HASH, kind: "keep" },
    } satisfies ExtensionDraft;
    const write = written(draft);
    expect(write.artifact).toBeUndefined();
    expect(write.body.execution).toEqual({
      contentHash: HASH,
      network: "none",
      type: "hosted_code",
    });
  });

  test("names every invalid field at once, one issue per field", () => {
    const draft = {
      ...draftOf("hosted_code"),
      description: "",
      entrypoint: "1bad",
      inputSchema: "{",
      memoryMiB: "lots",
      name: "bad name",
      outputSchema: '{"type":"array"}',
      requiredScopes: "a a",
      secrets: {
        entries: [
          { name: "PATH", value: "x" },
          { name: "PATH", value: "y" },
        ],
        kind: "replace",
      },
      source: { kind: "upload", language: "typescript", source: "" },
      timeoutMs: "99",
    } satisfies ExtensionDraft;
    const planned = createWrite(draft);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(
      Object.fromEntries(planned.issues.map(({ field, message }) => [field, message])),
    ).toEqual({
      description: 'Expected a value with a length of at least 1, got ""',
      entrypoint: 'Expected a string matching the RegExp ^[A-Za-z_][A-Za-z0-9_]{0,63}$, got "1bad"',
      inputSchema: "Enter valid JSON.",
      memoryMiB: "Enter a whole number.",
      name: "Tool names must use ASCII letters, numbers, dots, underscores, slashes, or hyphens without edge separators.",
      outputSchema: "Tool input schemas must declare type: object.",
      requiredScopes: "Scopes must not contain duplicates.",
      secrets: "Secret PATH appears more than once.",
      source: 'Expected a value with a length of at least 1, got ""',
      timeoutMs: "Expected a value between 100 and 50000, got 99",
    });
  });

  test("never echoes a callback secret the contract rejects", () => {
    const draft = {
      ...draftOf("http_callback"),
      callbackSecret: { kind: "replace", value: " leaked " },
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/hook",
    } satisfies ExtensionDraft;
    const planned = createWrite(draft);
    expect(planned.ok ? [] : planned.issues).toEqual([
      {
        field: "callbackSecret",
        message:
          "Enter a callback secret of at most 4,096 characters without leading or trailing spaces.",
      },
    ]);
  });
});

describe("editDraft", () => {
  test("vendor MCP tools are synced, never edited", () => {
    const vendor = tool({
      execution: {
        providerKey: "linear",
        remoteToolName: "search",
        toolHash: HASH,
        type: "vendor_mcp",
      },
    });
    expect(editDraft(vendor)).toBeUndefined();
  });

  test("an unchanged edit draft saves nothing", () => {
    const client = tool({ execution: { timeoutMs: 60_000, type: "client" } });
    const draft = editDraft(client);
    if (draft === undefined) throw new Error("client tools are editable");
    expect(updateWrite(client, draft)).toEqual({
      issues: [{ field: "form", message: "Nothing to save. Change a field first." }],
      ok: false,
    });
  });

  test("whitespace typed into a client tool's empty output schema is not an edit", () => {
    const client = tool({ execution: { timeoutMs: 60_000, type: "client" } });
    const draft = editDraft(client);
    if (draft?.type !== "client") throw new Error("client tools are editable");
    expect(updateWrite(client, { ...draft, outputSchema: " \n " })).toEqual({
      issues: [{ field: "form", message: "Nothing to save. Change a field first." }],
      ok: false,
    });
  });
});

describe("updateWrite", () => {
  const callback = tool({
    effect: "write",
    execution: {
      endpointOrigin: "https://callbacks.example.com",
      endpointPath: "/hook",
      type: "http_callback",
    },
    hasCallbackAuth: true,
    providerKey: "extension_callback",
  });

  function edited<Type extends ExecutionType>(before: ExtensionTool, type: Type) {
    const draft = editDraft(before);
    if (draft === undefined || !isType(draft, type)) throw new Error(`${type} is editable`);
    return draft;
  }

  test("sends only the changed fields with the version it read", () => {
    const planned = updateWrite(callback, {
      ...edited(callback, "http_callback"),
      defaultPolicyAction: "require_approval",
      description: "Look up one order.",
    });
    expect(planned.ok ? decodeUpdate(planned.write.body) : planned.issues).toEqual({
      defaultPolicyAction: "require_approval",
      description: "Look up one order.",
      expectedVersion: 3,
    });
  });

  test("a new callback endpoint needs a new secret, then sends both", () => {
    const moved = { ...edited(callback, "http_callback"), endpointPath: "/hook/v2" };
    expect(updateWrite(callback, moved)).toEqual({
      issues: [
        {
          field: "callbackSecret",
          message: "A new callback endpoint needs a new callback secret.",
        },
      ],
      ok: false,
    });
    const planned = updateWrite(callback, {
      ...moved,
      callbackSecret: { kind: "replace", value: "rotated" },
    });
    expect(planned.ok ? decodeUpdate(planned.write.body) : planned.issues).toEqual({
      callbackSecret: "rotated",
      execution: {
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/hook/v2",
        type: "http_callback",
      },
      expectedVersion: 3,
    });
  });

  test("an edited callback keeps the run context it opted in to", () => {
    const opted = tool({
      effect: "write",
      execution: {
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/hook",
        runContext: ["origin"],
        type: "http_callback",
      },
      hasCallbackAuth: true,
      providerKey: "extension_callback",
    });
    const planned = updateWrite(opted, {
      ...edited(opted, "http_callback"),
      callbackSecret: { kind: "replace", value: "rotated" },
      endpointPath: "/hook/v2",
    });
    expect(planned.ok ? decodeUpdate(planned.write.body) : planned.issues).toEqual({
      callbackSecret: "rotated",
      execution: {
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/hook/v2",
        runContext: ["origin"],
        type: "http_callback",
      },
      expectedVersion: 3,
    });
  });

  const HOSTED_EXECUTION = {
    contentHash: HASH,
    entrypoint: "handler",
    language: "javascript",
    memoryMiB: 256,
    network: "none",
    secretNames: ["BILLING_TOKEN"],
    sourceLanguage: "typescript",
    timeoutMs: 30_000,
    type: "hosted_code",
  };
  const hosted = tool({ execution: HOSTED_EXECUTION, outputSchema: { type: "object" } });

  test("new hosted source re-sends the whole execution for the server to pin", () => {
    const planned = updateWrite(hosted, {
      ...edited(hosted, "hosted_code"),
      source: { kind: "upload", language: "python", source: "def handler(input):\n  return {}\n" },
    });
    if (!planned.ok) throw new Error(JSON.stringify(planned.issues));
    expect(planned.write).toEqual({
      artifact: { language: "python", source: "def handler(input):\n  return {}\n" },
      body: {
        execution: {
          entrypoint: "handler",
          memoryMiB: 256,
          network: "none",
          timeoutMs: 30_000,
          type: "hosted_code",
        },
        expectedVersion: 3,
      },
    });
  });

  test("replacing hosted secrets sends the whole set and leaves the execution alone", () => {
    const planned = updateWrite(hosted, {
      ...edited(hosted, "hosted_code"),
      secrets: { entries: [{ name: "BILLING_TOKEN", value: "next" }], kind: "replace" },
    });
    expect(planned.ok ? planned.write : planned.issues).toEqual({
      body: { expectedVersion: 3, secrets: { BILLING_TOKEN: "next" } },
    });
  });

  test("an output schema cannot be cleared", () => {
    expect(updateWrite(hosted, { ...edited(hosted, "hosted_code"), outputSchema: " " })).toEqual({
      issues: [{ field: "outputSchema", message: "An output schema cannot be removed." }],
      ok: false,
    });
  });

  test("the execution type is immutable", () => {
    expect(updateWrite(hosted, draftOf("client"))).toEqual({
      issues: [{ field: "form", message: "The execution type of an extension cannot change." }],
      ok: false,
    });
  });

  test("after a newer version lands, a save sends only the operator's edits on top of it", () => {
    const loaded = edited(hosted, "hosted_code");
    const latest = tool({
      description: "Look up one order.",
      execution: { ...HOSTED_EXECUTION, contentHash: `sha256:${"b".repeat(64)}` },
      outputSchema: { type: "object" },
      version: 4,
    });
    const fresh = edited(latest, "hosted_code");
    const policyOnly = updateWrite(
      latest,
      rebaseDraft(loaded, fresh, { ...loaded, defaultPolicyAction: "deny" }),
    );
    expect(policyOnly.ok ? policyOnly.write : policyOnly.issues).toEqual({
      body: { defaultPolicyAction: "deny", expectedVersion: 4 },
    });
    const bothEdited = updateWrite(
      latest,
      rebaseDraft(loaded, fresh, { ...loaded, description: "Look up any order." }),
    );
    expect(bothEdited.ok ? bothEdited.write : bothEdited.issues).toEqual({
      body: { description: "Look up any order.", expectedVersion: 4 },
    });
  });

  test("a text-only difference is not an edit, so the newer value stays", () => {
    const loaded = edited(hosted, "hosted_code");
    const latest = tool({
      description: "Look up one order.",
      execution: { ...HOSTED_EXECUTION, memoryMiB: 512, timeoutMs: 20_000 },
      inputSchema: { properties: { id: { type: "string" } }, type: "object" },
      outputSchema: { type: "object" },
      requiredScopes: ["orders:read"],
      version: 4,
    });
    const planned = updateWrite(
      latest,
      rebaseDraft(loaded, edited(latest, "hosted_code"), {
        ...loaded,
        defaultPolicyAction: "deny",
        description: "Look up an order. ",
        inputSchema: '{"type":"object"}',
        memoryMiB: "0256",
        requiredScopes: " ",
        timeoutMs: " 30000",
      }),
    );
    expect(planned.ok ? planned.write : planned.issues).toEqual({
      body: { defaultPolicyAction: "deny", expectedVersion: 4 },
    });
  });

  test("an edit to a callback target or to hosted source keeps the operator's whole group", () => {
    const latestCallback = tool({
      ...callback,
      execution: {
        endpointOrigin: "https://hooks.example.com",
        endpointPath: "/hook",
        type: "http_callback",
      },
      version: 4,
    });
    const loadedCallback = edited(callback, "http_callback");
    const target = updateWrite(
      latestCallback,
      rebaseDraft(loadedCallback, edited(latestCallback, "http_callback"), {
        ...loadedCallback,
        callbackSecret: { kind: "replace", value: "rotated" },
        endpointPath: "/hook/v2",
      }),
    );
    expect(target.ok ? target.write : target.issues).toEqual({
      body: {
        callbackSecret: "rotated",
        execution: {
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/hook/v2",
          type: "http_callback",
        },
        expectedVersion: 4,
      },
    });
    const latestHosted = tool({
      execution: {
        ...HOSTED_EXECUTION,
        contentHash: `sha256:${"b".repeat(64)}`,
        entrypoint: "main",
      },
      outputSchema: { type: "object" },
      version: 4,
    });
    const loadedHosted = edited(hosted, "hosted_code");
    const source = updateWrite(
      latestHosted,
      rebaseDraft(loadedHosted, edited(latestHosted, "hosted_code"), {
        ...loadedHosted,
        source: { kind: "upload", language: "typescript", source: "export const run = 1;" },
      }),
    );
    expect(source.ok ? source.write : source.issues).toEqual({
      artifact: { language: "typescript", source: "export const run = 1;" },
      body: {
        execution: {
          entrypoint: "handler",
          memoryMiB: 256,
          network: "none",
          timeoutMs: 30_000,
          type: "hosted_code",
        },
        expectedVersion: 4,
      },
    });
  });

  test("an edit to an MCP remote tool keeps the operator's server with it", () => {
    const searchOnFirst = tool({
      execution: { mcpServerId: SERVER_ID, remoteToolName: "search", type: "mcp" },
    });
    const findOnSecond = tool({
      execution: { mcpServerId: "01M4CGXP4MSH02TQKZC4HB0CEW", remoteToolName: "find", type: "mcp" },
      version: 4,
    });
    const loaded = edited(searchOnFirst, "mcp");
    const planned = updateWrite(
      findOnSecond,
      rebaseDraft(loaded, edited(findOnSecond, "mcp"), { ...loaded, remoteToolName: "lookup" }),
    );
    expect<unknown>(planned.ok ? planned.write : planned.issues).toEqual({
      body: {
        execution: { mcpServerId: SERVER_ID, remoteToolName: "lookup", type: "mcp" },
        expectedVersion: 4,
      },
    });
  });

  test("a schema retyped with its keys in another order is not an edit, so the newer one stays", () => {
    const loaded = edited(
      tool({ inputSchema: { properties: { id: { type: "string" } }, type: "object" } }),
      "client",
    );
    const latest = tool({
      inputSchema: { properties: { id: { type: "number" } }, type: "object" },
      version: 4,
    });
    const planned = updateWrite(
      latest,
      rebaseDraft(loaded, edited(latest, "client"), {
        ...loaded,
        defaultPolicyAction: "deny",
        inputSchema: '{"type":"object","properties":{"id":{"type":"string"}}}',
      }),
    );
    expect(planned.ok ? planned.write : planned.issues).toEqual({
      body: { defaultPolicyAction: "deny", expectedVersion: 4 },
    });
  });

  test("a save sends a schema only when its JSON changes", () => {
    const client = tool({ inputSchema: { properties: {}, type: "object" } });
    const planned = updateWrite(client, {
      ...edited(client, "client"),
      description: "Look up one order.",
      inputSchema: ' {"type":"object","properties":{}} ',
    });
    expect(planned.ok ? planned.write : planned.issues).toEqual({
      body: { description: "Look up one order.", expectedVersion: 3 },
    });
  });
});
