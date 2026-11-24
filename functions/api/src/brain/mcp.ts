import { createHash } from "node:crypto";

type BrainFetch = (request: Request) => Promise<Response | undefined>;
type RpcRequest = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const MAX_REQUEST_BYTES = 64 * 1_024;
const MCP_PATH = "/v1/mcp/brain";

const tools = [
  {
    description: "Search one or more explicitly authorized Brains for cited evidence.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        brainIds: { items: { type: "string" }, maxItems: 20, minItems: 1, type: "array" },
        limit: { maximum: 50, minimum: 1, type: "integer" },
        query: { maxLength: 8_000, minLength: 1, type: "string" },
      },
      required: ["brainIds", "query"],
      type: "object",
    },
    name: "brain.search",
  },
  {
    description: "Answer a question from authorized Brain evidence with stable citations.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        brainIds: { items: { type: "string" }, maxItems: 20, minItems: 1, type: "array" },
        evidenceLimit: { maximum: 50, minimum: 1, type: "integer" },
        question: { maxLength: 8_000, minLength: 1, type: "string" },
      },
      required: ["brainIds", "question"],
      type: "object",
    },
    name: "brain.ask",
  },
  {
    description: "Read current immutable metadata for one authorized Brain document.",
    inputSchema: {
      additionalProperties: false,
      properties: { brainId: { type: "string" }, documentId: { type: "string" } },
      required: ["brainId", "documentId"],
      type: "object",
    },
    name: "brain.get_document",
  },
  {
    description: "Read one authorized canonical entity and its bounded one-hop relationships.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        brainId: { type: "string" },
        entityId: { type: "string" },
        limit: { maximum: 50, minimum: 1, type: "integer" },
      },
      required: ["brainId", "entityId"],
      type: "object",
    },
    name: "brain.get_entity",
  },
  {
    description: "Capture an attributable immutable text document through a Brain upload source.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        brainId: { type: "string" },
        content: { maxLength: 1_000_000, minLength: 1, type: "string" },
        externalItemIdentity: { maxLength: 1_024, minLength: 1, type: "string" },
        mediaType: { enum: ["application/json", "text/markdown", "text/plain"], type: "string" },
        sourceId: { type: "string" },
        sourceRevision: { maxLength: 1_024, minLength: 1, type: "string" },
        title: { maxLength: 200, minLength: 1, type: "string" },
      },
      required: ["brainId", "content", "externalItemIdentity", "sourceId", "title"],
      type: "object",
    },
    name: "brain.capture",
  },
] as const;

function rpc(id: RpcRequest["id"], result: unknown) {
  return Response.json(
    { ...(id === undefined ? {} : { id }), jsonrpc: "2.0", result },
    { headers: { "mcp-session-id": "deployments-ai-brain-v1" } },
  );
}

function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return Response.json({ error: { code, message }, id: id ?? null, jsonrpc: "2.0" });
}

function args(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

function requiredText(value: Readonly<Record<string, unknown>>, field: string) {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`brain.${field} is required.`);
  }
  return candidate.trim();
}

function forwardedHeaders(request: Request, idempotencyKey?: string) {
  const authorization = request.headers.get("authorization");
  const environment = request.headers.get("x-deployments-environment");
  const organization = request.headers.get("x-deployments-organization");
  const project = request.headers.get("x-deployments-project");
  return {
    ...(authorization ? { authorization } : {}),
    ...(environment ? { "x-deployments-environment": environment } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    ...(organization ? { "x-deployments-organization": organization } : {}),
    ...(project ? { "x-deployments-project": project } : {}),
  };
}

async function invokeApi(
  brainFetch: BrainFetch,
  request: Request,
  path: string,
  init: Omit<RequestInit, "headers"> & { readonly headers?: Readonly<Record<string, string>> } = {},
) {
  const response = await brainFetch(
    new Request(`https://brain.internal${path}`, {
      ...init,
      headers: { ...forwardedHeaders(request), ...init.headers },
    }),
  );
  if (!response) throw new Error("Hosted Brain MCP route is unavailable.");
  const body = await response.json();
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as Readonly<Record<string, unknown>>).detail)
        : "Brain operation failed.";
    throw new Error(detail);
  }
  return body;
}

async function callTool(brainFetch: BrainFetch, request: Request, message: RpcRequest) {
  const parameters = args(message.params);
  const name = requiredText(parameters, "name");
  const input = args(parameters.arguments);
  const idempotencyKey = `mcp-brain-${createHash("sha256")
    .update(`${String(message.id ?? "notification")}\0${name}\0${JSON.stringify(input)}`)
    .digest("hex")}`;
  let result: unknown;
  if (name === "brain.search" || name === "brain.ask") {
    result = await invokeApi(brainFetch, request, `/v1/brains/${name.slice("brain.".length)}`, {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      method: "POST",
    });
  } else if (name === "brain.get_document") {
    result = await invokeApi(
      brainFetch,
      request,
      `/v1/brains/${encodeURIComponent(requiredText(input, "brainId"))}/documents/${encodeURIComponent(requiredText(input, "documentId"))}`,
    );
  } else if (name === "brain.get_entity") {
    const limit = typeof input.limit === "number" ? `?limit=${input.limit}` : "";
    result = await invokeApi(
      brainFetch,
      request,
      `/v1/brains/${encodeURIComponent(requiredText(input, "brainId"))}/entities/${encodeURIComponent(requiredText(input, "entityId"))}${limit}`,
    );
  } else if (name === "brain.capture") {
    const brainId = requiredText(input, "brainId");
    const sourceId = requiredText(input, "sourceId");
    const content = requiredText(input, "content");
    const mediaType =
      typeof input.mediaType === "string" && input.mediaType.trim()
        ? input.mediaType.trim()
        : "text/markdown";
    const bytes = new TextEncoder().encode(content);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const ticket = (await invokeApi(
      brainFetch,
      request,
      `/v1/brains/${encodeURIComponent(brainId)}/sources/${encodeURIComponent(sourceId)}/uploads`,
      {
        body: JSON.stringify({
          expectedByteSize: bytes.byteLength,
          expectedContentHash: contentHash,
          mediaType,
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${idempotencyKey}:ticket`,
        },
        method: "POST",
      },
    )) as Readonly<Record<string, unknown>>;
    const ticketId = requiredText(ticket, "id");
    await invokeApi(
      brainFetch,
      request,
      `/v1/brains/${encodeURIComponent(brainId)}/sources/${encodeURIComponent(sourceId)}/uploads/${encodeURIComponent(ticketId)}/content`,
      {
        body: bytes,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": mediaType,
          "idempotency-key": `${idempotencyKey}:content`,
        },
        method: "PUT",
      },
    );
    result = await invokeApi(
      brainFetch,
      request,
      `/v1/brains/${encodeURIComponent(brainId)}/sources/${encodeURIComponent(sourceId)}/documents`,
      {
        body: JSON.stringify({
          completedUploadTicketId: ticketId,
          externalItemIdentity: requiredText(input, "externalItemIdentity"),
          kind: "content",
          mediaType,
          sourceRevision:
            typeof input.sourceRevision === "string" && input.sourceRevision.trim()
              ? input.sourceRevision.trim()
              : idempotencyKey,
          title: requiredText(input, "title"),
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${idempotencyKey}:capture`,
        },
        method: "POST",
      },
    );
  } else {
    throw new TypeError("Unknown Brain MCP tool.");
  }
  return { content: [{ text: JSON.stringify(result), type: "text" }], isError: false };
}

export function createHostedBrainMcp(brainFetch: BrainFetch) {
  return async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== MCP_PATH) return undefined;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return new Response(null, { status: 413 });
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES)
      return new Response(null, { status: 413 });
    let message: RpcRequest;
    try {
      message = JSON.parse(raw) as RpcRequest;
    } catch {
      return rpcError(undefined, -32700, "Parse error.");
    }
    const probe = await brainFetch(
      new Request("https://brain.internal/v1/brains?limit=1", {
        headers: forwardedHeaders(request),
      }),
    );
    if (!probe?.ok) return probe ?? new Response(null, { status: 401 });
    if (message.method === "initialize") {
      return rpc(message.id, {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        serverInfo: { name: "deployments-ai-brain", version: "1.0.0" },
      });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, {
        headers: { "mcp-session-id": "deployments-ai-brain-v1" },
        status: 202,
      });
    }
    if (message.method === "tools/list") return rpc(message.id, { tools });
    if (message.method === "tools/call") {
      try {
        return rpc(message.id, await callTool(brainFetch, request, message));
      } catch (cause) {
        return rpc(message.id, {
          content: [
            {
              text: cause instanceof Error ? cause.message : "Brain operation failed.",
              type: "text",
            },
          ],
          isError: true,
        });
      }
    }
    return rpcError(message.id, -32601, "Method not found.");
  };
}
