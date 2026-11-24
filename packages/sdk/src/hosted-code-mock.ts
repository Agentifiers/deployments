import { createHash } from "node:crypto";
import type { PlatformRequest } from "./index.ts";

const ARTIFACT_PATH = /^\/v1\/hosted-code-artifacts\/(sha256:[a-f0-9]{64})$/u;
const EXTENSION_PATH = /^\/v1\/extensions\/([^/]+)$/u;

function mockArtifact(contentHash: string, language: string, byteSize: number, now: string) {
  return {
    byteSize,
    contentHash,
    createdAt: now,
    language: language === "python" ? "python" : "javascript",
    sourceByteSize: byteSize,
    sourceContentHash: contentHash,
    sourceLanguage: language,
  };
}

/** Deterministic hosted code artifact and hosted_code extension responses for the mock transport. */
export function mockHostedCodeData(
  request: PlatformRequest,
  now: string,
): { readonly matched: false } | { readonly matched: true; readonly data: unknown } {
  const body =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};
  if (request.path === "/v1/hosted-code-artifacts" && request.method === "POST") {
    const source = typeof body.source === "string" ? body.source : "";
    const language = typeof body.language === "string" ? body.language : "javascript";
    const bytes = new TextEncoder().encode(source);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return { matched: true, data: mockArtifact(contentHash, language, bytes.byteLength, now) };
  }
  const artifact = ARTIFACT_PATH.exec(request.path);
  if (artifact && request.method === "GET") {
    return { matched: true, data: mockArtifact(artifact[1]!, "javascript", 64, now) };
  }
  const extension = EXTENSION_PATH.exec(request.path);
  if (extension && (request.method === "GET" || request.method === "PATCH")) {
    const execution =
      body.execution && typeof body.execution === "object"
        ? (body.execution as Record<string, unknown>)
        : {};
    const secrets =
      body.secrets && typeof body.secrets === "object"
        ? Object.keys(body.secrets as Record<string, unknown>).sort()
        : [];
    return {
      matched: true,
      data: {
        createdAt: now,
        defaultPolicyAction: "allow",
        description: typeof body.description === "string" ? body.description : "Mock tool",
        effect: typeof body.effect === "string" ? body.effect : "read",
        execution: {
          contentHash:
            typeof execution.contentHash === "string"
              ? execution.contentHash
              : `sha256:${"0".repeat(64)}`,
          entrypoint: typeof execution.entrypoint === "string" ? execution.entrypoint : "handler",
          language: "javascript",
          memoryMiB: typeof execution.memoryMiB === "number" ? execution.memoryMiB : 256,
          network: execution.network === "sandbox" ? "sandbox" : "none",
          secretNames: secrets,
          sourceLanguage: "javascript",
          timeoutMs: typeof execution.timeoutMs === "number" ? execution.timeoutMs : 30_000,
          type: "hosted_code",
        },
        hasCallbackAuth: false,
        id: "tool_mock",
        inputSchema: body.inputSchema ?? { type: "object" },
        name: decodeURIComponent(extension[1]!),
        outputSchema: body.outputSchema ?? { type: "object" },
        requiredScopes: [],
        status: "active",
        updatedAt: now,
        version: typeof body.expectedVersion === "number" ? body.expectedVersion + 1 : 1,
      },
    };
  }
  return { matched: false };
}
