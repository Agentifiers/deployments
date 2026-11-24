import "@tanstack/react-start/server-only";
import type { DirectoryResponse } from "@deployments-ai/api-contract";
import type { IssuedDirectoryToken } from "../sign-in/directory.ts";
import { decodeRequestBody } from "./request-body.ts";
import type { SignInMutation } from "./sign-in-actions.ts";
import { signInPlatform, type SignInPlatform } from "./sign-in-data.ts";

export function putDirectory(
  { accessToken, body, idempotencyKey, scope }: SignInMutation & { readonly body: unknown },
  client: SignInPlatform = signInPlatform,
): Promise<DirectoryResponse> {
  return client.callRoute(
    "putDirectory",
    {
      body: decodeRequestBody("putDirectory", "PutDirectoryRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export async function createDirectoryToken(
  { accessToken, idempotencyKey, scope }: SignInMutation,
  client: SignInPlatform = signInPlatform,
): Promise<IssuedDirectoryToken> {
  const {
    token: { secret, ...view },
  } = await client.callRoute("createDirectoryToken", { idempotencyKey, scope }, accessToken);
  return { secret, view };
}

export function revokeDirectoryToken(
  { accessToken, id, idempotencyKey, scope }: SignInMutation & { readonly id: string },
  client: SignInPlatform = signInPlatform,
): Promise<DirectoryResponse> {
  return client.callRoute(
    "revokeDirectoryToken",
    { idempotencyKey, path: { id }, scope },
    accessToken,
  );
}
