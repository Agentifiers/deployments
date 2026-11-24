import "@tanstack/react-start/server-only";
import type { BrainResponse } from "@deployments-ai/api-contract/brains";
import {
  documentView,
  entityView,
  reviewItemView,
  type BrainDocumentView,
  type BrainEntityView,
  type BrainIndexHealth,
  type BrainReviewItemView,
} from "../brains/content.ts";
import { erasureView, type BrainErasure } from "../brains/erasure.ts";
import type { BrainGrant, BrainMount, BrainSource, BrainView } from "../brains/model.ts";
import { PlatformApiError } from "../errors.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute as platformCallRoute, collectPages } from "./platform-api.ts";

type CallRoute = typeof platformCallRoute;

export function listBrains(
  accessToken: string,
  organizationId: string,
  cursor: string | undefined,
): Promise<Page<BrainResponse>> {
  return fillPage(
    (pageCursor, limit) =>
      platformCallRoute(
        "listBrains",
        { query: { cursor: pageCursor, limit }, scope: { organizationId } },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export async function getBrainView(
  accessToken: string,
  organizationId: string,
  brainId: string,
  callRoute: CallRoute = platformCallRoute,
): Promise<BrainView> {
  const scope = { organizationId };
  const [brain, owner] = await Promise.all([
    callRoute("getBrain", { path: { brainId }, scope }, accessToken),
    callRoute(
      "listBrainGrants",
      { path: { brainId }, query: { limit: 1 }, scope },
      accessToken,
    ).then(
      () => true,
      (error: unknown) => {
        if (error instanceof PlatformApiError && error.problem.status === 403) return false;
        throw error;
      },
    ),
  ]);
  return { brain, standing: owner ? { kind: "owner" } : { kind: "grantee" } };
}

export async function listBrainSources(
  accessToken: string,
  organizationId: string,
  brainId: string,
  cursor: string | undefined,
  callRoute: CallRoute = platformCallRoute,
): Promise<Page<BrainSource>> {
  const page = await callRoute(
    "listBrainSources",
    { path: { brainId }, query: { cursor, limit: PAGE_SIZE }, scope: { organizationId } },
    accessToken,
  );
  return {
    items: page.items.map(({ configuration: _configuration, ...source }) => source),
    nextCursor: page.nextCursor,
  };
}

export function listBrainGrants(
  accessToken: string,
  organizationId: string,
  brainId: string,
): Promise<readonly BrainGrant[]> {
  return collectPages((cursor) =>
    platformCallRoute(
      "listBrainGrants",
      { path: { brainId }, query: { cursor, limit: API_PAGE_LIMIT }, scope: { organizationId } },
      accessToken,
    ),
  );
}

export function listBrainMounts(
  accessToken: string,
  organizationId: string,
  brainId: string,
): Promise<readonly BrainMount[]> {
  return collectPages((cursor) =>
    platformCallRoute(
      "listBrainMounts",
      { path: { brainId }, query: { cursor, limit: API_PAGE_LIMIT }, scope: { organizationId } },
      accessToken,
    ),
  );
}

export function listBrainIndexHealth(
  accessToken: string,
  organizationId: string,
  brainId: string,
  cursor: string | undefined,
): Promise<Page<BrainIndexHealth>> {
  return platformCallRoute(
    "listBrainIndexHealth",
    { path: { brainId }, query: { cursor, limit: PAGE_SIZE }, scope: { organizationId } },
    accessToken,
  );
}

export async function getBrainDocument(
  accessToken: string,
  organizationId: string,
  brainId: string,
  documentId: string,
): Promise<BrainDocumentView> {
  return documentView(
    await platformCallRoute(
      "getBrainDocument",
      { path: { brainId, documentId }, scope: { organizationId } },
      accessToken,
    ),
  );
}

export async function getBrainEntity(
  accessToken: string,
  organizationId: string,
  brainId: string,
  entityId: string,
): Promise<BrainEntityView> {
  return entityView(
    await platformCallRoute(
      "getBrainEntity",
      { path: { brainId, entityId }, query: { limit: 50 }, scope: { organizationId } },
      accessToken,
    ),
  );
}

export async function listBrainReviewItems(
  accessToken: string,
  organizationId: string,
  brainId: string,
  cursor: string | undefined,
): Promise<Page<BrainReviewItemView>> {
  const page = await platformCallRoute(
    "listBrainReviewItems",
    { path: { brainId }, query: { cursor, limit: PAGE_SIZE }, scope: { organizationId } },
    accessToken,
  );
  return { items: page.items.map(reviewItemView), nextCursor: page.nextCursor };
}

export async function getBrainErasure(
  accessToken: string,
  organizationId: string,
  brainId: string,
  erasureId: string,
): Promise<BrainErasure> {
  return erasureView(
    await platformCallRoute(
      "getBrainErasure",
      { path: { brainId, erasureId }, scope: { organizationId } },
      accessToken,
    ),
  );
}
