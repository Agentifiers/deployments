import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { createHttpApiV2Handler, type HttpApiV2Event, type HttpApiV2Result } from "./lambda.ts";

export const E2E_MCP_TOOL_NAME = "e2e-echo";
const E2E_MCP_SECRET_ARN_ENV = "DEPLOYMENTS_AI_E2E_MCP_SECRET_ARN";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_MARKER_CHARACTERS = 256;

export interface E2eMcpCredentials {
  readonly initial: string;
  readonly rotated: string;
}

type JsonRpcRequest = {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

function rpc(id: number | string | undefined, result: unknown, status = 200) {
  return Response.json(
    {
      ...(id === undefined ? {} : { id }),
      jsonrpc: "2.0",
      result,
    },
    {
      headers: { "mcp-session-id": "deployments-ai-e2e" },
      status,
    },
  );
}

function credentialName(pathname: string): keyof E2eMcpCredentials | undefined {
  if (pathname === "/_e2e/mcp/initial") return "initial";
  if (pathname === "/_e2e/mcp/rotated") return "rotated";
  return undefined;
}

export function createE2eMcpFetch(loadCredentials: () => Promise<E2eMcpCredentials>) {
  return async (request: Request): Promise<Response> => {
    const selected = credentialName(new URL(request.url).pathname);
    if (!selected) return new Response(null, { status: 404 });
    const credentials = await loadCredentials();
    if (request.headers.get("authorization") !== `Bearer ${credentials[selected]}`) {
      return Response.json(
        { error: "unauthorized" },
        { headers: { "www-authenticate": "Bearer" }, status: 401 },
      );
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    let message: JsonRpcRequest;
    try {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      const body = await request.text();
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      message = parsed as JsonRpcRequest;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (message.method === "initialize") {
      return rpc(message.id, {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        serverInfo: { name: "deployments-ai-e2e-mcp", version: "1.0.0" },
      });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, {
        headers: { "mcp-session-id": "deployments-ai-e2e" },
        status: 202,
      });
    }
    if (message.method === "tools/list") {
      return rpc(message.id, {
        tools: [
          {
            description: "Returns a deterministic marker for deployed MCP end-to-end evidence.",
            inputSchema: {
              additionalProperties: false,
              properties: { marker: { type: "string" } },
              required: ["marker"],
              type: "object",
            },
            name: E2E_MCP_TOOL_NAME,
          },
        ],
      });
    }
    if (message.method === "tools/call") {
      const params = message.params;
      const argumentsValue =
        params?.arguments &&
        typeof params.arguments === "object" &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Readonly<Record<string, unknown>>)
          : {};
      if (
        params?.name !== E2E_MCP_TOOL_NAME ||
        typeof argumentsValue.marker !== "string" ||
        argumentsValue.marker.length > MAX_MARKER_CHARACTERS
      ) {
        return Response.json(
          {
            error: { code: -32602, message: "Expected e2e-echo with a bounded string marker." },
            id: message.id ?? null,
            jsonrpc: "2.0",
          },
          { status: 200 },
        );
      }
      return rpc(message.id, {
        content: [{ text: `E2E MCP echo: ${argumentsValue.marker}`, type: "text" }],
        isError: false,
      });
    }
    return Response.json(
      {
        error: { code: -32601, message: "Method not found." },
        id: message.id ?? null,
        jsonrpc: "2.0",
      },
      { status: 200 },
    );
  };
}

async function loadCredentials() {
  const secretArn = process.env[E2E_MCP_SECRET_ARN_ENV]?.trim();
  if (!secretArn) throw new Error(`${E2E_MCP_SECRET_ARN_ENV} is required.`);
  {
    const value = await loadAwsSecretString(secretArn);
    const parsed = JSON.parse(value) as Partial<E2eMcpCredentials>;
    if (!parsed.initial?.trim() || !parsed.rotated?.trim() || parsed.initial === parsed.rotated) {
      throw new Error("E2E MCP secret must contain distinct initial and rotated tokens.");
    }
    return { initial: parsed.initial, rotated: parsed.rotated };
  }
}

const fetchHandler = createE2eMcpFetch(loadCredentials);
const lambdaHandler = createHttpApiV2Handler(fetchHandler);

export function handler(event: HttpApiV2Event): Promise<HttpApiV2Result> {
  return lambdaHandler(event);
}
