import type { DirectoryResponse, PutDirectoryRequest } from "@deployments-ai/api-contract";
import type { ShownOnce } from "../shown-once.ts";

export type DirectoryRole = PutDirectoryRequest["defaultRole"];

export const DIRECTORY_ROLES = ["member", "viewer"] as const satisfies readonly DirectoryRole[];

export type DirectoryToken = DirectoryResponse["tokens"][number];

/** A created SCIM token: its secret appears in the create response and nowhere else. */
export type IssuedDirectoryToken = ShownOnce<DirectoryToken>;

/** Two tokens let an identity provider move to a new one before the old one is revoked. */
const MAX_DIRECTORY_TOKENS = 2;

export type TokenSlots =
  | { readonly kind: "empty" }
  | { readonly kind: "open" }
  | { readonly kind: "full"; readonly reason: string };

export type DirectoryView =
  | { readonly kind: "off" }
  | {
      readonly kind: "on";
      readonly directory: DirectoryResponse;
      /** Newest first. */
      readonly tokens: readonly DirectoryToken[];
      readonly slots: TokenSlots;
    };

export function directoryView(directory: DirectoryResponse | null): DirectoryView {
  if (directory === null) return { kind: "off" };
  return {
    directory,
    kind: "on",
    slots: tokenSlots(directory.tokens.length),
    tokens: directory.tokens.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    ),
  };
}

function tokenSlots(count: number): TokenSlots {
  if (count === 0) return { kind: "empty" };
  if (count < MAX_DIRECTORY_TOKENS) return { kind: "open" };
  return {
    kind: "full",
    reason:
      "A directory holds at most two tokens. Revoke the one your identity provider no longer uses, then create a new one.",
  };
}

export type DefaultRoleRequest =
  | { readonly kind: "ready"; readonly body: PutDirectoryRequest }
  | { readonly kind: "unchanged" };

/** Turning directory sync on always sends; a configured directory sends only a different role. */
export function defaultRoleRequest(
  directory: DirectoryResponse | null,
  role: DirectoryRole,
): DefaultRoleRequest {
  return directory?.defaultRole === role
    ? { kind: "unchanged" }
    : { body: { defaultRole: role }, kind: "ready" };
}

/** What revoking `token` does to provisioning, given the directory's other tokens. */
export function revokeConsequence(directory: DirectoryResponse, token: DirectoryToken): string {
  return directory.tokens.some(({ id }) => id !== token.id)
    ? `Requests with ${token.tokenPrefix}… get 401 at once. Move your identity provider to the other token first.`
    : `Requests with ${token.tokenPrefix}… get 401 at once, and provisioning stops until you create a new token and paste it into your identity provider.`;
}
