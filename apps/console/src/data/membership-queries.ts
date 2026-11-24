import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  loadInvitationPage,
  loadMemberDirectory,
  loadMemberPage,
} from "../server/membership-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { pageInputAt, type PageInputAt } from "./server-input.ts";

const fetchMemberPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) => loadMemberPage(await requireAccessToken(), data.scope, data.cursor));

const fetchMemberDirectory = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) => loadMemberDirectory(await requireAccessToken(), data.scope));

const fetchInvitationPage = createServerFn({ method: "GET" })
  .validator((input: PageInputAt<"organization">) => pageInputAt("organization", input))
  .handler(async ({ data }) =>
    loadInvitationPage(await requireAccessToken(), data.scope, data.cursor),
  );

const cursorField = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

export const membersQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchMemberPage({ data: { scope: { organizationId }, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["members", organizationId],
  });

export const memberDirectoryQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchMemberDirectory({ data: { scope: { organizationId } } }),
    queryKey: ["members", organizationId, "directory"],
  });

/** Pending invitations only; accepted, revoked, and expired ones never appear. */
export const invitationsQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchInvitationPage({ data: { scope: { organizationId }, ...cursorField(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["invitations", organizationId],
  });

export function invalidateMembers(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: ["members", organizationId] });
}

export function invalidateInvitations(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: ["invitations", organizationId] });
}
