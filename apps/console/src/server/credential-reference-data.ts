import "@tanstack/react-start/server-only";
import type { CredentialReference, OwnerType } from "../secrets/secret-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute } from "./platform-api.ts";

export async function loadCredentialReferencePage(
  accessToken: string,
  scope: EnvironmentScope,
  ownerType: OwnerType | undefined,
  cursor: string | undefined,
): Promise<Page<CredentialReference>> {
  const page = await callRoute(
    "listCredentialReferences",
    { query: { cursor, limit: PAGE_SIZE, ownerType }, scope },
    accessToken,
  );
  return { items: page.items, nextCursor: page.nextCursor ?? undefined };
}
