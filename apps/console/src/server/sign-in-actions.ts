import "@tanstack/react-start/server-only";
import type {
  IdentityProviderLinkResponse,
  IdentityProviderResponse,
  LoginDomainResponse,
} from "@deployments-ai/api-contract";
import { decodeRequestBody } from "./request-body.ts";
import { signInPlatform, type OrganizationScope, type SignInPlatform } from "./sign-in-data.ts";

export interface SignInMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: OrganizationScope;
}

type BodyMutation = SignInMutation & { readonly body: unknown };
type IdMutation = SignInMutation & { readonly id: string };

export function addLoginDomain(
  { accessToken, body, idempotencyKey, scope }: BodyMutation,
  client: SignInPlatform = signInPlatform,
): Promise<LoginDomainResponse> {
  return client.callRoute(
    "addLoginDomain",
    {
      body: decodeRequestBody("addLoginDomain", "AddLoginDomainRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function verifyLoginDomain(
  { accessToken, id, idempotencyKey, scope }: IdMutation,
  client: SignInPlatform = signInPlatform,
): Promise<LoginDomainResponse> {
  return client.callRoute(
    "verifyLoginDomain",
    { idempotencyKey, path: { id }, scope },
    accessToken,
  );
}

export function removeLoginDomain(
  { accessToken, id, idempotencyKey, scope }: IdMutation,
  client: SignInPlatform = signInPlatform,
): Promise<LoginDomainResponse> {
  return client.callRoute(
    "removeLoginDomain",
    { idempotencyKey, path: { id }, scope },
    accessToken,
  );
}

export function putIdentityProvider(
  { accessToken, body, idempotencyKey, scope }: BodyMutation,
  client: SignInPlatform = signInPlatform,
): Promise<IdentityProviderResponse> {
  return client.callRoute(
    "putIdentityProvider",
    {
      body: decodeRequestBody("putIdentityProvider", "PutIdentityProviderRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function setIdentityProviderState(
  { accessToken, body, idempotencyKey, scope }: BodyMutation,
  client: SignInPlatform = signInPlatform,
): Promise<IdentityProviderResponse> {
  return client.callRoute(
    "setIdentityProviderState",
    {
      body: decodeRequestBody("setIdentityProviderState", "SetIdentityProviderStateRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function deleteIdentityProvider(
  { accessToken, idempotencyKey, scope }: SignInMutation,
  client: SignInPlatform = signInPlatform,
): Promise<IdentityProviderResponse> {
  return client.callRoute("deleteIdentityProvider", { idempotencyKey, scope }, accessToken);
}

export function deleteIdentityProviderLink(
  { accessToken, id, idempotencyKey, scope }: IdMutation,
  client: SignInPlatform = signInPlatform,
): Promise<IdentityProviderLinkResponse> {
  return client.callRoute(
    "deleteIdentityProviderLink",
    { idempotencyKey, path: { id }, scope },
    accessToken,
  );
}
