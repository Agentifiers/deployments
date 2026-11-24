import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type PlatformApiClient } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface ExtensionMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

/** An extension write; `artifact` is new hosted code source the server uploads first. */
export interface ExtensionWrite extends ExtensionMutation {
  readonly artifact?: unknown;
  readonly body: unknown;
}

type Platform = Pick<PlatformApiClient, "callRoute">;

const platform: Platform = { callRoute };

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Uploads new hosted code source, then names its artifact in the body. Both requests derive their
 * keys from the dialog's one key, so retrying a write that failed between them resumes it.
 */
async function withArtifact(write: ExtensionWrite, client: Platform): Promise<unknown> {
  const { accessToken, artifact, body, idempotencyKey, scope } = write;
  if (artifact === undefined) return body;
  const { contentHash } = await client.callRoute(
    "createHostedCodeArtifact",
    {
      body: decodeRequestBody(
        "createHostedCodeArtifact",
        "CreateHostedCodeArtifactRequest",
        artifact,
      ),
      idempotencyKey: `${idempotencyKey}:artifact`,
      scope,
    },
    accessToken,
  );
  return { ...record(body), execution: { ...record(record(body).execution), contentHash } };
}

export async function createExtension(write: ExtensionWrite, client: Platform = platform) {
  const body = await withArtifact(write, client);
  const { id, name } = await client.callRoute(
    "createExtensionTool",
    {
      body: decodeRequestBody("createExtensionTool", "CreateExtensionToolRequest", body),
      idempotencyKey: `${write.idempotencyKey}:extension`,
      scope: write.scope,
    },
    write.accessToken,
  );
  return { id, name };
}

export async function updateExtension(
  write: ExtensionWrite & { readonly toolName: string },
  client: Platform = platform,
) {
  const body = await withArtifact(write, client);
  const { id, name, version } = await client.callRoute(
    "updateExtensionTool",
    {
      body: decodeRequestBody("updateExtensionTool", "UpdateExtensionToolRequest", body),
      idempotencyKey: `${write.idempotencyKey}:extension`,
      path: { toolName: write.toolName },
      scope: write.scope,
    },
    write.accessToken,
  );
  return { id, name, version };
}

export async function archiveExtension({
  accessToken,
  expectedVersion,
  idempotencyKey,
  scope,
  toolName,
}: ExtensionMutation & { readonly expectedVersion: number; readonly toolName: string }) {
  const { id, name, status } = await callRoute(
    "archiveExtensionTool",
    { body: { expectedVersion }, idempotencyKey, path: { toolName }, scope },
    accessToken,
  );
  return { id, name, status };
}

export function syncConnectionTools({
  accessToken,
  connectionId,
  idempotencyKey,
  scope,
}: ExtensionMutation & { readonly connectionId: string }) {
  return callRoute(
    "syncConnectionTools",
    { idempotencyKey, path: { connectionId }, scope },
    accessToken,
  );
}
