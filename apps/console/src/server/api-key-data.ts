import "@tanstack/react-start/server-only";
import { OPERATIONAL_RECORD_PAGE_LIMIT } from "@deployments-ai/api-contract";
import {
  directoryPage,
  groupKeysByAccount,
  type ApiKeyView,
  type DirectoryPage,
  type DirectoryView,
  type ServiceAccountView,
} from "../api-keys/directory.ts";
import {
  summarizeKeyUsage,
  usageWindowBounds,
  type KeyUsage,
  type OperationalRecord,
} from "../api-keys/usage.ts";
import { PlatformApiError } from "../errors.ts";
import type { MetricRange } from "../observability/range.ts";
import type { EnvironmentScope } from "../scope.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

const MAX_USAGE_PAGES = 5;
const DIRECTORY_PAGE_SIZE = 25;

export type KeyLookup =
  | {
      readonly account: ServiceAccountView | undefined;
      readonly apiKey: ApiKeyView;
      readonly kind: "found";
    }
  | { readonly kind: "missing" };

export async function loadApiKeyDirectoryPage(
  accessToken: string,
  scope: EnvironmentScope,
  view: DirectoryView,
  offset: number,
): Promise<DirectoryPage> {
  const [accounts, keys] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listServiceAccounts",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    collectPages((cursor) =>
      callRoute(
        "listApiCredentials",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
  ]);
  return directoryPage(groupKeysByAccount(accounts, keys, new Date()), {
    offset,
    pageSize: DIRECTORY_PAGE_SIZE,
    view,
  });
}

export async function loadApiKey(
  accessToken: string,
  scope: EnvironmentScope,
  apiCredentialId: string,
): Promise<KeyLookup> {
  const keys = await collectPages((cursor) =>
    callRoute(
      "listApiCredentials",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
  const apiKey = keys.find((key) => key.id === apiCredentialId);
  if (apiKey === undefined) return { kind: "missing" };
  try {
    const account = await callRoute(
      "getServiceAccount",
      { path: { id: apiKey.serviceAccountId }, scope },
      accessToken,
    );
    return { account, apiKey, kind: "found" };
  } catch (error) {
    if (!(error instanceof PlatformApiError && error.problem.status === 404)) throw error;
    return { account: undefined, apiKey, kind: "found" };
  }
}

export async function loadKeyUsage(
  accessToken: string,
  scope: EnvironmentScope,
  apiCredentialId: string,
  window: MetricRange,
): Promise<KeyUsage> {
  const { since, until } = usageWindowBounds(window, new Date());
  const records: OperationalRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_USAGE_PAGES; page += 1) {
    const response = await callRoute(
      "listApiCredentialUsage",
      {
        query: { apiCredentialId, cursor, limit: OPERATIONAL_RECORD_PAGE_LIMIT, since, until },
        scope,
      },
      accessToken,
    );
    records.push(...response.items);
    cursor = response.nextCursor;
    if (cursor === undefined) break;
  }
  return summarizeKeyUsage(records, cursor === undefined);
}
